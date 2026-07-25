// K8sEngine —— 继承 LinuxEngine（本地文件系统），叠加 Kubernetes 集群状态
// 集群对象：nodes / namespaces / pods / deployments / services
import { LinuxEngine } from './linux-engine.js';

export class K8sEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.nodes = [
      { name: 'node-1', status: 'Ready', roles: 'control-plane', cpu: '4', mem: '16Gi', ver: 'v1.29.0' },
      { name: 'node-2', status: 'Ready', roles: 'worker', cpu: '8', mem: '32Gi', ver: 'v1.29.0' },
    ];
    this.namespaces = ['default', 'kube-system'];
    this.pods = [];         // { name, namespace, status, image, node, ip, restarts, ready, logs: [], owner, labels }
    this.deployments = [];  // { name, namespace, replicas, image, labels }
    this.services = [];     // { name, namespace, type, clusterIp, port, targetPort, selector, labels }
    this._podSeq = 0;
    this._seedCluster();
  }

  /* ---- 确定性 hex（便于测试） ---- */
  _hex(n) { return (((n * 2654435761) >>> 0) % 0xFFFF).toString(16).padStart(4, '0'); }

  /* ---- 预置一个示例 Deployment（关卡 setup 可清空或复用） ---- */
  _seedCluster() {
    this.createDeployment('frontend', 'nginx:alpine', 2, 'default');
  }

  /* ---- 查找 ---- */
  findPod(key, ns = 'default') {
    return this.pods.find(p => p.namespace === ns && (p.name === key || p.name.startsWith(key)));
  }
  findDeployment(key, ns = 'default') {
    return this.deployments.find(d => d.namespace === ns && (d.name === key || d.name.startsWith(key)));
  }
  findService(key, ns = 'default') {
    return this.services.find(s => s.namespace === ns && (s.name === key || s.name.startsWith(key)));
  }
  podsOfDeployment(name, ns = 'default') {
    return this.pods.filter(p => p.namespace === ns && p.owner === name);
  }

  /* ---- Pod 生命周期 ---- */
  _podName(owner) {
    const suffix = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][this._podSeq % 8];
    return `${owner}-${this._hex(++this._podSeq)}-${suffix}${this._podSeq}`;
  }
  createPod(owner, image, ns = 'default', status = 'Running', labels = null, name = null) {
    const podName = name || this._podName(owner || 'pod');
    if (name) this._podSeq++; // 显式命名（kubectl run）也推进序号，保证 ip 不重复
    const nodeIdx = this._podSeq % this.nodes.length;
    const pod = {
      name: podName,
      namespace: ns,
      status,
      image,
      node: this.nodes[nodeIdx].name,
      ip: `10.244.${nodeIdx}.${(this._podSeq % 250) + 2}`,
      restarts: status === 'Running' ? 0 : 3,
      ready: status === 'Running' ? '1/1' : '0/1',
      logs: status === 'Running'
        ? [`INFO ${image} started`, 'INFO listening on :80']
        : ['INFO starting...', 'ERROR config not found', 'FATAL exit code 1'],
      owner: owner || null,
      labels: labels || (owner ? { app: owner } : {}),
    };
    this.pods.push(pod);
    return pod;
  }

  createDeployment(name, image, replicas = 1, ns = 'default', labels = null) {
    let d = this.findDeployment(name, ns);
    if (!d) {
      d = { name, namespace: ns, replicas, image, labels: labels ? { app: name, ...labels } : { app: name } };
      this.deployments.push(d);
    } else {
      d.replicas = replicas; d.image = image;
      if (labels) d.labels = { ...d.labels, ...labels };
    }
    this._reconcile(d);
    return d;
  }

  // 让 Pod 数量与 Deployment 期望副本数一致
  _reconcile(d) {
    const cur = this.podsOfDeployment(d.name, d.namespace);
    while (cur.length < d.replicas) { cur.push(this.createPod(d.name, d.image, d.namespace, 'Running', d.labels)); }
    while (cur.length > d.replicas) {
      const gone = cur.pop();
      this.pods = this.pods.filter(p => p !== gone);
    }
  }

  deletePod(key, ns = 'default') {
    const pod = this.findPod(key, ns);
    if (!pod) return false;
    this.pods = this.pods.filter(p => p !== pod);
    // 若属于某 Deployment，控制器会重建一个健康的 Pod
    if (pod.owner) {
      const d = this.findDeployment(pod.owner, ns);
      if (d) this._reconcile(d);
    }
    return true;
  }

  deleteDeployment(key, ns = 'default') {
    const d = this.findDeployment(key, ns);
    if (!d) return false;
    this.pods = this.pods.filter(p => !(p.namespace === ns && p.owner === d.name));
    this.deployments = this.deployments.filter(x => x !== d);
    this.services = this.services.filter(s => !(s.namespace === ns && s.selector === d.name));
    return true;
  }

  deleteService(key, ns = 'default') {
    const s = this.findService(key, ns);
    if (!s) return false;
    this.services = this.services.filter(x => x !== s);
    return true;
  }

  createService(name, target, port, type = 'ClusterIP', ns = 'default', labels = null) {
    let s = this.findService(name, ns);
    if (!s) {
      s = { name, namespace: ns, type, clusterIp: `10.96.0.${10 + this.services.length}`, port, targetPort: port, selector: target, labels: labels ? { app: name, ...labels } : { app: name } };
      this.services.push(s);
    } else if (labels) {
      s.labels = { ...(s.labels || {}), ...labels };
    }
    return s;
  }

  /* ---- 简易 YAML manifest 解析（kubectl apply -f 用） ---- */
  // 支持 key: value 行：kind / name / image / replicas / port / type / namespace
  // 支持 labels：缩进的 labels: 块（子行 key: value），或行内 labels: k=v,k2=v2
  parseManifest(text) {
    const obj = {};
    let labels = null, labelsIndent = -1;
    for (const raw of text.split('\n')) {
      const indent = raw.match(/^\s*/)[0].length;
      const m = raw.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      // 处于 labels: 块内（更深缩进的行归入 labels）
      if (labels && indent > labelsIndent) {
        if (m[2] && !m[2].startsWith('#')) labels[m[1]] = m[2];
        continue;
      }
      labels = null;
      const key = m[1].toLowerCase();
      if (key === 'labels') {
        if (!m[2]) { labels = obj.labels = {}; labelsIndent = indent; }
        else {
          obj.labels = {};
          for (const kv of m[2].split(',')) {
            const i = kv.indexOf('=');
            if (i > 0) obj.labels[kv.slice(0, i)] = kv.slice(i + 1);
            else if (kv) obj.labels[kv] = 'true';
          }
        }
        continue;
      }
      if (m[2] && !m[2].startsWith('#')) obj[key] = m[2];
    }
    return obj;
  }
}
