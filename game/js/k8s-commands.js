// Kubernetes 命令集 —— kubectl
// kubectl 由本模块处理，其余命令委托 linuxExecute。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

export function k8sExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();

  const base = input.split(/\s/)[0];
  if (base === 'help') {
    printCmd(input);
    [
      '── kubectl 查看 ──',
      '  kubectl get pods|deployments|services|nodes|ns [-n 命名空间]',
      '  kubectl get all · kubectl describe pod <名> · kubectl logs <pod>',
      '── kubectl 操作 ──',
      '  kubectl create deployment <名> --image=<镜像> [--replicas=N]',
      '  kubectl scale deployment <名> --replicas=N',
      '  kubectl expose deployment <名> --port=80 [--type=NodePort]',
      '  kubectl apply -f <文件.yaml> · kubectl delete pod|deployment <名>',
      '  kubectl exec <pod> -- <命令>',
      '── 其余 ──',
      '  ls · cat · echo ... 照常可用 · clear 清屏',
    ].forEach(l => print(l, 'info'));
    return;
  }
  if (base === 'kubectl') {
    printCmd(input);
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track('kubectl'); e.used.add('kubectl');
    runKubectl(input, e);
    return;
  }
  // 其余 → 本地 linux 命令
  linuxExecute(input);
}

/* ============ kubectl 子命令 ============ */
function runKubectl(input, e) {
  const t = tokenize(input);
  const sub = t[1];
  const rest = t.slice(2);
  // 解析全局 -n / --namespace
  let ns = 'default';
  const ni = rest.indexOf('-n');
  if (ni >= 0 && rest[ni + 1]) { ns = rest[ni + 1]; rest.splice(ni, 2); }
  const nsLong = rest.findIndex(a => a.startsWith('--namespace='));
  if (nsLong >= 0) { ns = rest[nsLong].split('=')[1]; rest.splice(nsLong, 1); }

  const fn = KUBECTL[sub];
  if (!fn) {
    print(`error: unknown command "${sub || '(空)'}" —— 试试 kubectl get pods`, 'err');
    sfx('err-syntax'); after(false); return;
  }
  fn(rest, e, ns, input);
}

const KUBECTL = {
  get(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    const out = [];
    const pushPods = (list, nss) => {
      out.push(pad('NAME', 26) + pad('READY', 7) + pad('STATUS', 20) + pad('RESTARTS', 9) + 'NODE');
      for (const p of list) if (!nss || p.namespace === nss)
        out.push(pad(p.name, 26) + pad(p.ready, 7) + pad(p.status, 20) + pad(String(p.restarts), 9) + p.node);
    };
    if (kind === 'pods' || kind === 'pod' || kind === 'po') {
      const list = e.pods.filter(p => p.namespace === ns);
      if (!list.length) out.push('No resources found in ' + ns + ' namespace.');
      else pushPods(list, null);
    } else if (kind === 'deployments' || kind === 'deployment' || kind === 'deploy') {
      const list = e.deployments.filter(d => d.namespace === ns);
      out.push(pad('NAME', 14) + pad('READY', 9) + pad('UP-TO-DATE', 11) + 'IMAGE');
      for (const d of list) {
        const ready = e.podsOfDeployment(d.name, ns).filter(p => p.status === 'Running').length;
        out.push(pad(d.name, 14) + pad(`${ready}/${d.replicas}`, 9) + pad(String(d.replicas), 11) + d.image);
      }
      if (!list.length) out.push('No resources found in ' + ns + ' namespace.');
    } else if (kind === 'services' || kind === 'service' || kind === 'svc') {
      const list = e.services.filter(s => s.namespace === ns);
      out.push(pad('NAME', 14) + pad('TYPE', 11) + pad('CLUSTER-IP', 13) + 'PORT');
      for (const s of list) out.push(pad(s.name, 14) + pad(s.type, 11) + pad(s.clusterIp, 13) + `${s.port}:${s.targetPort}/TCP`);
      if (!list.length) out.push('No resources found in ' + ns + ' namespace.');
    } else if (kind === 'nodes' || kind === 'node' || kind === 'no') {
      out.push(pad('NAME', 10) + pad('STATUS', 9) + pad('ROLES', 16) + pad('CPU', 5) + 'MEMORY');
      for (const n of e.nodes) out.push(pad(n.name, 10) + pad(n.status, 9) + pad(n.roles, 16) + pad(n.cpu, 5) + n.mem);
    } else if (kind === 'namespaces' || kind === 'namespace' || kind === 'ns') {
      out.push(pad('NAME', 14) + 'STATUS');
      for (const n of e.namespaces) out.push(pad(n, 14) + 'Active');
    } else if (kind === 'all') {
      out.push('── pods ──'); pushPods(e.pods, null);
      out.push('── deployments ──');
      out.push(pad('NAME', 14) + pad('READY', 9) + 'IMAGE');
      for (const d of e.deployments) {
        const ready = e.podsOfDeployment(d.name, d.namespace).filter(p => p.status === 'Running').length;
        out.push(pad(d.name, 14) + pad(`${ready}/${d.replicas}`, 9) + d.image);
      }
      out.push('── services ──');
      out.push(pad('NAME', 14) + pad('TYPE', 11) + 'CLUSTER-IP');
      for (const s of e.services) out.push(pad(s.name, 14) + pad(s.type, 11) + s.clusterIp);
    } else {
      print(`error: the server doesn't have a resource type "${kind}"`, 'err');
      sfx('err-syntax'); after(false); return;
    }
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  describe(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    if (!name) { print('error: 需要资源名，如 kubectl describe pod <名>', 'err'); sfx('err-syntax'); after(false); return; }
    const out = [];
    if (kind === 'pod' || kind === 'pods') {
      const p = e.findPod(name, ns);
      if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      out.push(`Name:         ${p.name}`, `Namespace:    ${p.namespace}`, `Status:       ${p.status}`,
        `Node:         ${p.node}`, `Image:        ${p.image}`, `Ready:        ${p.ready}`,
        `Restarts:     ${p.restarts}`, `Controlled By: ${p.owner ? 'Deployment/' + p.owner : '(无)'}`,
        'Events:', `  Normal  Scheduled  Successfully assigned ${p.namespace}/${p.name} to ${p.node}`,
        `  Normal  Pulled     Container image "${p.image}" already present on machine`);
    } else if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') {
      const d = e.findDeployment(name, ns);
      if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      const ready = e.podsOfDeployment(d.name, ns).filter(p => p.status === 'Running').length;
      out.push(`Name:               ${d.name}`, `Namespace:          ${d.namespace}`,
        `Replicas:           ${d.replicas} desired | ${ready} ready`, `Image:              ${d.image}`,
        `Selector:           app=${d.name}`);
    } else {
      print(`error: 不支持 describe ${kind}`, 'err'); sfx('err-syntax'); after(false); return;
    }
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  logs(rest, e, ns) {
    const name = rest[0];
    if (!name) { print('error: 需要 pod 名，如 kubectl logs <pod>', 'err'); sfx('err-syntax'); after(false); return; }
    const p = e.findPod(name, ns);
    if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    p.logs.forEach(l => print(l, l.startsWith('ERROR') || l.startsWith('FATAL') ? 'err' : 'out'));
    e.lastOut = p.logs.join('\n');
    sfx('text-grep'); after(true);
  },

  create(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    if (kind !== 'deployment') { print(`error: 暂只支持 create deployment`, 'err'); sfx('err-syntax'); after(false); return; }
    const name = rest[1];
    const imgFlag = rest.find(a => a.startsWith('--image='));
    const repFlag = rest.find(a => a.startsWith('--replicas='));
    if (!name || !imgFlag) { print('用法：kubectl create deployment <名> --image=<镜像> [--replicas=N]', 'err'); sfx('err-syntax'); after(false); return; }
    const image = imgFlag.split('=')[1];
    const replicas = repFlag ? parseInt(repFlag.split('=')[1]) : 1;
    e.createDeployment(name, image, replicas, ns);
    print(`deployment.apps/${name} created`, 'ok');
    sfx('net-connect'); after(true);
  },

  scale(rest, e, ns) {
    // kubectl scale deployment <名> --replicas=N
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const repFlag = rest.find(a => a.startsWith('--replicas='));
    if (kind !== 'deployment' || !name || !repFlag) { print('用法：kubectl scale deployment <名> --replicas=N', 'err'); sfx('err-syntax'); after(false); return; }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const n = parseInt(repFlag.split('=')[1]);
    d.replicas = n;
    e._reconcile(d);
    print(`deployment.apps/${name} scaled`, 'ok');
    sfx('net-connect'); after(true);
  },

  expose(rest, e, ns) {
    // kubectl expose deployment <名> --port=80 [--type=NodePort]
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const portFlag = rest.find(a => a.startsWith('--port='));
    const typeFlag = rest.find(a => a.startsWith('--type='));
    if (kind !== 'deployment' || !name) { print('用法：kubectl expose deployment <名> --port=80 [--type=NodePort]', 'err'); sfx('err-syntax'); after(false); return; }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const port = portFlag ? parseInt(portFlag.split('=')[1]) : 80;
    const type = typeFlag ? typeFlag.split('=')[1] : 'ClusterIP';
    e.createService(d.name, d.name, port, type, ns);
    print(`service/${d.name} exposed`, 'ok');
    sfx('net-connect'); after(true);
  },

  delete(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    if (!name) { print('用法：kubectl delete pod|deployment <名>', 'err'); sfx('err-syntax'); after(false); return; }
    if (kind === 'pod' || kind === 'pods') {
      if (e.deletePod(name, ns)) { print(`pod "${name}" deleted`, 'ok'); sfx('ui-close'); after(true); }
      else { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); }
    } else if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') {
      if (e.deleteDeployment(name, ns)) { print(`deployment.apps "${name}" deleted`, 'ok'); sfx('ui-close'); after(true); }
      else { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); }
    } else {
      print(`error: 暂只支持 delete pod|deployment`, 'err'); sfx('err-syntax'); after(false);
    }
  },

  apply(rest, e) {
    const fi = rest.indexOf('-f');
    const file = fi >= 0 ? rest[fi + 1] : null;
    if (!file) { print('用法：kubectl apply -f <文件.yaml>', 'err'); sfx('err-syntax'); after(false); return; }
    const r = e.readFile(file);
    if (r.err) { print(`error: the path "${file}" does not exist`, 'err'); sfx('err-syntax'); after(false); return; }
    const m = e.parseManifest(r.content);
    const kind = (m.kind || '').toLowerCase();
    const ns = m.namespace || 'default';
    if (kind === 'deployment') {
      if (!m.name || !m.image) { print('error: manifest 缺少 name / image', 'err'); sfx('err-syntax'); after(false); return; }
      e.createDeployment(m.name, m.image, parseInt(m.replicas) || 1, ns);
      print(`deployment.apps/${m.name} configured`, 'ok');
    } else if (kind === 'service') {
      if (!m.name) { print('error: manifest 缺少 name', 'err'); sfx('err-syntax'); after(false); return; }
      e.createService(m.name, m.target || m.name, parseInt(m.port) || 80, m.type || 'ClusterIP', ns);
      print(`service/${m.name} configured`, 'ok');
    } else {
      print(`error: 不支持的 kind "${m.kind || '(空)'}"（支持 Deployment / Service）`, 'err');
      sfx('err-syntax'); after(false); return;
    }
    sfx('net-connect'); after(true);
  },

  exec(rest, e, ns) {
    // kubectl exec <pod> -- <命令...>
    const name = rest[0];
    const p = e.findPod(name, ns);
    if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const sep = rest.indexOf('--');
    const cmd = sep >= 0 ? rest.slice(sep + 1).join(' ') : '';
    if (!cmd) { print('用法：kubectl exec <pod> -- <命令>', 'err'); sfx('err-syntax'); after(false); return; }
    const out = [`[in ${p.name}] $ ${cmd}`, `(${p.image} 容器内执行) ${cmd} 输出模拟`];
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  version(_rest, e) {
    const out = ['Client Version: v1.29.0', 'Server Version: v1.29.0'];
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  'cluster-info'(_rest, e) {
    const out = ['Kubernetes control plane is running at https://10.0.0.1:6443', 'CoreDNS is running at https://10.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns'];
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },
};

function pad(s, w) { s = String(s); return s.length >= w ? s + ' ' : s + ' '.repeat(w - s.length); }
