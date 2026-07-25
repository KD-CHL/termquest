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
      '  kubectl get pods|deployments|services|nodes|ns|events|cm|secret|hpa [-n 命名空间]',
      '  kubectl get all · kubectl get po|deploy|svc|no（别名）',
      '  kubectl get pods -o wide|name|yaml|json · --show-labels · --sort-by=.metadata.name',
      '  kubectl get pods -l key=value · --field-selector metadata.name=x · -w',
      '  kubectl describe pod|deployment|service|node <名> · kubectl explain pod',
      '  kubectl logs <pod> [--tail=N] [-f] [-p] [-c 容器] [--all-containers] [--since=1h]',
      '  kubectl top pods|nodes · kubectl get events',
      '── kubectl 操作 ──',
      '  kubectl create deployment <名> --image=<镜像> [--replicas=N]',
      '  kubectl create namespace|configmap|secret|service <名> ...',
      '  kubectl run <pod名> --image=<镜像> [--labels=k=v,k2=v2]',
      '  kubectl scale deployment <名> --replicas=N · kubectl autoscale deployment <名> --min=2 --max=5',
      '  kubectl expose deployment <名> --port=80 [--type=NodePort]',
      '  kubectl rollout status|restart|history|undo deployment/<名>',
      '  kubectl set image deployment/<名> <容器>=<镜像> · kubectl patch deployment <名> -p \'{"spec":{"replicas":3}}\'',
      '  kubectl label pod|deployment <名> key=value [--overwrite] · kubectl annotate ...',
      '  kubectl apply -f <文件.yaml> · kubectl edit pod|deployment <名>',
      '  kubectl delete pod|deployment|service <名> · --all · -l key=value · -f <文件.yaml>',
      '  kubectl exec <pod> -- <命令> · kubectl cp <pod>:<路径> <本地> · kubectl port-forward <资源> 端口',
      '── 节点 / 集群 ──',
      '  kubectl cordon|uncordon|drain <节点> · kubectl taint nodes <节点> key=value:NoSchedule',
      '  kubectl config view|use-context|get-contexts|current-context',
      '  kubectl api-resources · kubectl api-versions · kubectl auth can-i <动作> <资源> · kubectl wait',
      '  kubectl version · kubectl cluster-info',
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
    // -o / --output：wide | name | yaml | json
    let fmt = '';
    const oi = rest.indexOf('-o');
    if (oi >= 0 && rest[oi + 1]) { fmt = rest[oi + 1]; rest.splice(oi, 2); }
    const oLong = rest.findIndex(a => a.startsWith('--output='));
    if (oLong >= 0) { fmt = rest[oLong].split('=')[1]; rest.splice(oLong, 1); }
    // -l / --selector：标签筛选
    let sel = '';
    const li = rest.indexOf('-l');
    if (li >= 0 && rest[li + 1]) { sel = rest[li + 1]; rest.splice(li, 2); }
    const selLong = rest.findIndex(a => a.startsWith('--selector='));
    if (selLong >= 0) { sel = rest[selLong].split('=')[1]; rest.splice(selLong, 1); }
    // --sort-by=.metadata.name
    let sortBy = '';
    const sbi = rest.findIndex(a => a.startsWith('--sort-by='));
    if (sbi >= 0) { sortBy = rest[sbi].slice('--sort-by='.length); rest.splice(sbi, 1); }
    else { const sb2 = rest.indexOf('--sort-by'); if (sb2 >= 0 && rest[sb2 + 1]) { sortBy = rest[sb2 + 1]; rest.splice(sb2, 2); } }
    // --field-selector metadata.name=x
    let fieldSel = '';
    const fsi = rest.findIndex(a => a.startsWith('--field-selector='));
    if (fsi >= 0) { fieldSel = rest[fsi].slice('--field-selector='.length); rest.splice(fsi, 1); }
    else { const fs2 = rest.indexOf('--field-selector'); if (fs2 >= 0 && rest[fs2 + 1]) { fieldSel = rest[fs2 + 1]; rest.splice(fs2, 2); } }
    // 布尔开关
    const watch = takeFlag(rest, '-w') || takeFlag(rest, '--watch');
    const showLabels = takeFlag(rest, '--show-labels');
    const allNs = takeFlag(rest, '-A') || takeFlag(rest, '--all-namespaces');
    if (allNs) ns = null; // null = 跨命名空间

    const wide = fmt === 'wide';

    const kind = (rest.find(a => !a.startsWith('-')) || '').toLowerCase();
    const name = rest.filter(a => !a.startsWith('-'))[1];
    const out = [];

    const isPod = kind === 'pods' || kind === 'pod' || kind === 'po';
    const isDep = kind === 'deployments' || kind === 'deployment' || kind === 'deploy';
    const isSvc = kind === 'services' || kind === 'service' || kind === 'svc';
    const isNode = kind === 'nodes' || kind === 'node' || kind === 'no';
    const isNs = kind === 'namespaces' || kind === 'namespace' || kind === 'ns';
    const isCm = kind === 'configmaps' || kind === 'configmap' || kind === 'cm';
    const isSec = kind === 'secrets' || kind === 'secret';
    const isHpa = kind === 'hpa' || kind === 'hpas' || kind === 'horizontalpodautoscalers';
    const isEv = kind === 'events' || kind === 'event' || kind === 'ev';

    if (isPod || isDep || isSvc || isNode || isNs || isCm || isSec || isHpa) {
      let objs, prefix;
      const inNs = o => ns === null || o.namespace === ns;
      if (isPod) { objs = e.pods.filter(inNs); prefix = 'pod'; }
      else if (isDep) { objs = e.deployments.filter(inNs); prefix = 'deployment.apps'; }
      else if (isSvc) { objs = e.services.filter(inNs); prefix = 'service'; }
      else if (isNode) { objs = e.nodes.slice(); prefix = 'node'; }
      else if (isNs) { objs = e.namespaces.map(n => ({ name: n })); prefix = 'namespace'; }
      else if (isCm) { objs = e.configmaps.filter(inNs); prefix = 'configmap'; }
      else if (isSec) { objs = e.secrets.filter(inNs); prefix = 'secret'; }
      else { objs = e.hpas.filter(inNs); prefix = 'horizontalpodautoscaler.autoscaling'; }

      if (name) {
        // get <kind> <name>：单个资源（前缀匹配）
        const one = objs.find(o => o.name === name) || objs.find(o => o.name.startsWith(name));
        if (!one) { print(`Error from server (NotFound): ${kind} "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
        objs = [one];
      } else if (sel) {
        objs = objs.filter(o => matchSelector(o, sel));
      }
      if (fieldSel) objs = objs.filter(o => matchFieldSelector(o, fieldSel, isPod));
      if (sortBy) objs = objs.slice().sort(sortByField(sortBy));

      if (fmt === 'yaml' || fmt === 'json') {
        const cleaned = objs.map(clean);
        let text;
        if (name) text = fmt === 'json' ? JSON.stringify(cleaned[0], null, 2) : toYaml(cleaned[0]);
        else if (fmt === 'json') text = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: cleaned }, null, 2);
        else text = cleaned.map(o => toYaml(o)).join('\n---\n');
        text.split('\n').forEach(l => out.push(l));
      } else if (fmt === 'name') {
        for (const o of objs) out.push(`${prefix}/${o.name}`);
      } else if (isPod) {
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
        else {
          out.push(pad('NAME', 26) + pad('READY', 7) + pad('STATUS', 20) + pad('RESTARTS', 9) + (wide ? pad('IP', 17) : '') + 'NODE' + (showLabels ? pad('', 1) + 'LABELS' : ''));
          for (const p of objs)
            out.push(pad(p.name, 26) + pad(p.ready, 7) + pad(p.status, 20) + pad(String(p.restarts), 9) + (wide ? pad(p.ip || '-', 17) : '') + p.node + (showLabels ? pad('', 1) + selStr(p) : ''));
        }
      } else if (isDep) {
        out.push(pad('NAME', 14) + pad('READY', 9) + pad('UP-TO-DATE', 11) + (wide ? pad('IMAGE', 20) + 'SELECTOR' : 'IMAGE'));
        for (const d of objs) {
          const ready = e.podsOfDeployment(d.name, d.namespace).filter(p => p.status === 'Running').length;
          out.push(pad(d.name, 14) + pad(`${ready}/${d.replicas}`, 9) + pad(String(d.replicas), 11) + (wide ? pad(d.image, 20) + selStr(d) : d.image));
        }
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
      } else if (isSvc) {
        out.push(pad('NAME', 14) + pad('TYPE', 11) + pad('CLUSTER-IP', 13) + (wide ? pad('PORT', 16) + 'SELECTOR' : 'PORT') + (showLabels ? pad('', 1) + 'LABELS' : ''));
        for (const s of objs)
          out.push(pad(s.name, 14) + pad(s.type, 11) + pad(s.clusterIp, 13) + (wide ? pad(`${s.port}:${s.targetPort}/TCP`, 16) + (s.selector || '') : `${s.port}:${s.targetPort}/TCP`) + (showLabels ? pad('', 1) + selStr(s) : ''));
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
      } else if (isNode) {
        out.push(pad('NAME', 10) + pad('STATUS', 9) + pad('ROLES', 16) + pad('CPU', 5) + (wide ? pad('MEMORY', 8) + 'VERSION' : 'MEMORY') + (showLabels ? pad('', 1) + 'LABELS' : ''));
        for (const n of objs)
          out.push(pad(n.name, 10) + pad(n.status, 9) + pad(n.roles, 16) + pad(n.cpu, 5) + (wide ? pad(n.mem, 8) + n.ver : n.mem) + (showLabels ? pad('', 1) + selStr(n) : ''));
      } else if (isNs) {
        out.push(pad('NAME', 14) + 'STATUS');
        for (const n of objs) out.push(pad(n.name, 14) + 'Active');
      } else if (isCm) {
        out.push(pad('NAME', 16) + pad('DATA', 6) + 'AGE');
        for (const c of objs) out.push(pad(c.name, 16) + pad(String(Object.keys(c.data || {}).length), 6) + '1m');
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
      } else if (isSec) {
        out.push(pad('NAME', 16) + pad('TYPE', 26) + pad('DATA', 6) + 'AGE');
        for (const s of objs) out.push(pad(s.name, 16) + pad(s.type, 26) + pad(String(Object.keys(s.data || {}).length), 6) + '1m');
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
      } else { // hpa
        out.push(pad('NAME', 14) + pad('REFERENCE', 22) + pad('TARGETS', 16) + pad('MINPODS', 9) + pad('MAXPODS', 9) + 'REPLICAS');
        for (const h of objs) out.push(pad(h.name, 14) + pad(`Deployment/${h.target}`, 22) + pad(`${h.cpu}%/80%`, 16) + pad(String(h.min), 9) + pad(String(h.max), 9) + String(h.min));
        if (!objs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
      }
    } else if (isEv) {
      // get events
      const evs = e.eventsFor(ns || 'default');
      out.push(pad('LAST SEEN', 11) + pad('TYPE', 9) + pad('REASON', 18) + pad('OBJECT', 30) + 'MESSAGE');
      for (const ev of evs) out.push(pad(ev.age, 11) + pad(ev.type, 9) + pad(ev.reason, 18) + pad(ev.obj, 30) + ev.msg);
      if (!evs.length) out.push('No resources found in ' + (ns || 'default') + ' namespace.');
    } else if (kind === 'all') {
      const pushPods = (list, nss) => {
        out.push(pad('NAME', 26) + pad('READY', 7) + pad('STATUS', 20) + pad('RESTARTS', 9) + 'NODE');
        for (const p of list) if (!nss || p.namespace === nss)
          out.push(pad(p.name, 26) + pad(p.ready, 7) + pad(p.status, 20) + pad(String(p.restarts), 9) + p.node);
      };
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
    if (watch) out.push('(watch 模式：TermQuest 仅展示一次快照，Ctrl-C 退出)');
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  describe(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    if (!name) { print('error: 需要资源名，如 kubectl describe pod <名>', 'err'); sfx('err-syntax'); after(false); return; }
    const out = [];
    if (kind === 'pod' || kind === 'pods' || kind === 'po') {
      const p = e.findPod(name, ns);
      if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      out.push(`Name:         ${p.name}`, `Namespace:    ${p.namespace}`, `Status:       ${p.status}`,
        `Node:         ${p.node}`, `IP:           ${p.ip || '-'}`, `Image:        ${p.image}`, `Ready:        ${p.ready}`,
        `Restarts:     ${p.restarts}`, `Labels:       ${selStr(p) || '(无)'}`,
        `Controlled By: ${p.owner ? 'Deployment/' + p.owner : '(无)'}`,
        'Events:', `  Normal  Scheduled  Successfully assigned ${p.namespace}/${p.name} to ${p.node}`,
        `  Normal  Pulled     Container image "${p.image}" already present on machine`);
    } else if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') {
      const d = e.findDeployment(name, ns);
      if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      const ready = e.podsOfDeployment(d.name, ns).filter(p => p.status === 'Running').length;
      out.push(`Name:               ${d.name}`, `Namespace:          ${d.namespace}`,
        `Replicas:           ${d.replicas} desired | ${ready} ready`, `Image:              ${d.image}`,
        `Selector:           app=${d.name}`, `Revision:           ${d.revision || 1}`);
    } else if (kind === 'service' || kind === 'services' || kind === 'svc') {
      const s = e.findService(name, ns);
      if (!s) { print(`Error from server (NotFound): services "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      out.push(`Name:         ${s.name}`, `Namespace:    ${s.namespace}`, `Type:         ${s.type}`,
        `IP:           ${s.clusterIp}`, `Port:         ${s.port}/${s.targetPort}/TCP`, `Selector:     ${s.selector || '(无)'}`);
    } else if (kind === 'node' || kind === 'nodes' || kind === 'no') {
      const n = e.nodes.find(x => x.name === name) || e.nodes.find(x => x.name.startsWith(name));
      if (!n) { print(`Error from server (NotFound): nodes "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      out.push(`Name:         ${n.name}`, `Status:       ${n.status}`, `Roles:        ${n.roles}`,
        `Capacity:     cpu=${n.cpu} memory=${n.mem}`, `Version:      ${n.ver}`,
        `Unschedulable: ${n.unschedulable ? 'true' : 'false'}`,
        `Taints:       ${(n.taints && n.taints.length) ? n.taints.join(', ') : '(无)'}`);
    } else {
      print(`error: the server doesn't have a resource type "${kind}"`, 'err'); sfx('err-syntax'); after(false); return;
    }
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n');
    sfx('text-grep'); after(true);
  },

  logs(rest, e, ns) {
    // kubectl logs <pod> [--tail=N] [-f] [-p] [-c 容器] [--all-containers] [--since=1h]
    let tail = 0;
    const ti = rest.findIndex(a => a.startsWith('--tail='));
    if (ti >= 0) { tail = parseInt(rest[ti].split('=')[1], 10) || 0; rest.splice(ti, 1); }
    else { const t2 = rest.indexOf('--tail'); if (t2 >= 0 && rest[t2 + 1]) { tail = parseInt(rest[t2 + 1], 10) || 0; rest.splice(t2, 2); } }
    let since = '';
    const si = rest.findIndex(a => a.startsWith('--since='));
    if (si >= 0) { since = rest[si].split('=')[1]; rest.splice(si, 1); }
    else { const s2 = rest.indexOf('--since'); if (s2 >= 0 && rest[s2 + 1]) { since = rest[s2 + 1]; rest.splice(s2, 2); } }
    let container = '';
    const ci = rest.findIndex(a => a.startsWith('-c='));
    if (ci >= 0) { container = rest[ci].slice(3); rest.splice(ci, 1); }
    else { const c2 = rest.indexOf('-c'); if (c2 >= 0 && rest[c2 + 1]) { container = rest[c2 + 1]; rest.splice(c2, 2); } }
    const follow = takeFlag(rest, '-f') || takeFlag(rest, '--follow');
    const prev = takeFlag(rest, '-p') || takeFlag(rest, '--previous');
    const allC = takeFlag(rest, '--all-containers');

    const name = rest.find(a => !a.startsWith('-'));
    if (!name) { print('error: 需要 pod 名，如 kubectl logs <pod>', 'err'); sfx('err-syntax'); after(false); return; }
    const p = e.findPod(name, ns);
    if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const cname = container || (p.image || 'app').split(':')[0].split('/').pop() || 'app';
    const out = [];
    if (prev) out.push(`(显示上一次容器实例的日志，容器 ${cname})`);
    if (since) out.push(`(仅显示最近 ${since} 的日志)`);
    let lines = tail > 0 ? p.logs.slice(-tail) : p.logs;
    if (allC || container) lines = lines.map(l => `[${cname}] ${l}`);
    lines.forEach(l => print(l, l.startsWith('ERROR') || l.startsWith('FATAL') || l.includes(' ERROR ') || l.includes(' FATAL ') ? 'err' : 'out'));
    if (follow) print(`(follow 模式：已附加到容器 ${cname} 的日志流，Ctrl-C 退出)`, 'info');
    e.lastOut = (out.length ? out.join('\n') + '\n' : '') + lines.join('\n');
    sfx('text-grep'); after(true);
  },

  run(rest, e, ns) {
    // kubectl run <pod名> --image=<镜像> [--labels=k=v,k2=v2]
    const name = rest[0];
    const imgFlag = rest.find(a => a.startsWith('--image='));
    if (!name || name.startsWith('-') || !imgFlag) {
      print('用法：kubectl run <pod名> --image=<镜像> [--labels=k=v,k2=v2]', 'err'); sfx('err-syntax'); after(false); return;
    }
    const image = imgFlag.split('=')[1];
    if (e.pods.some(p => p.namespace === ns && p.name === name)) {
      print(`Error from server (AlreadyExists): pods "${name}" already exists`, 'err'); sfx('err-syntax'); after(false); return;
    }
    const labels = { app: name };
    const lFlag = rest.find(a => a.startsWith('--labels='));
    if (lFlag) Object.assign(labels, parseLabels(lFlag.slice('--labels='.length)));
    e.createPod(null, image, ns, 'Running', labels, name);
    print(`pod/${name} created`, 'ok');
    sfx('net-connect'); after(true);
  },

  create(rest, e, ns) {
    const kind = (rest[0] || '').toLowerCase();
    if (kind === 'deployment') {
      const name = rest[1];
      const imgFlag = rest.find(a => a.startsWith('--image='));
      const repFlag = rest.find(a => a.startsWith('--replicas='));
      if (!name || !imgFlag) { print('用法：kubectl create deployment <名> --image=<镜像> [--replicas=N]', 'err'); sfx('err-syntax'); after(false); return; }
      const image = imgFlag.split('=')[1];
      const replicas = repFlag ? parseInt(repFlag.split('=')[1]) : 1;
      e.createDeployment(name, image, replicas, ns);
      print(`deployment.apps/${name} created`, 'ok');
      sfx('net-connect'); after(true); return;
    }
    if (kind === 'namespace' || kind === 'ns') {
      const name = rest[1];
      if (!name) { print('用法：kubectl create namespace <名>', 'err'); sfx('err-syntax'); after(false); return; }
      if (e.namespaces.includes(name)) { print(`Error from server (AlreadyExists): namespaces "${name}" already exists`, 'err'); sfx('err-syntax'); after(false); return; }
      e.namespaces.push(name);
      print(`namespace/${name} created`, 'ok'); sfx('net-connect'); after(true); return;
    }
    if (kind === 'configmap' || kind === 'cm') {
      const name = rest[1];
      if (!name) { print('用法：kubectl create configmap <名> --from-literal=k=v[,k2=v2] | --from-file=<文件>', 'err'); sfx('err-syntax'); after(false); return; }
      const data = collectData(rest, e);
      e.configmaps.push({ name, namespace: ns, data });
      print(`configmap/${name} created`, 'ok'); sfx('net-connect'); after(true); return;
    }
    if (kind === 'secret') {
      // kubectl create secret generic <名> ... （也接受直接 create secret <名>）
      let name = rest[1];
      let type = 'Opaque';
      if (name === 'generic' || name === 'docker-registry' || name === 'tls') { type = name === 'generic' ? 'Opaque' : name === 'tls' ? 'kubernetes.io/tls' : 'kubernetes.io/dockerconfigjson'; name = rest[2]; }
      if (!name) { print('用法：kubectl create secret generic <名> --from-literal=k=v[,k2=v2]', 'err'); sfx('err-syntax'); after(false); return; }
      const data = collectData(rest, e);
      e.secrets.push({ name, namespace: ns, type, data });
      print(`secret/${name} created`, 'ok'); sfx('net-connect'); after(true); return;
    }
    if (kind === 'service') {
      // kubectl create service clusterip <名> --tcp=80:8080
      let name = rest[1];
      let type = 'ClusterIP';
      if (['clusterip', 'nodeport', 'loadbalancer'].includes(name)) {
        type = name === 'clusterip' ? 'ClusterIP' : name === 'nodeport' ? 'NodePort' : 'LoadBalancer';
        name = rest[2];
      }
      if (!name) { print('用法：kubectl create service clusterip <名> --tcp=80:8080', 'err'); sfx('err-syntax'); after(false); return; }
      const tcpFlag = rest.find(a => a.startsWith('--tcp='));
      let port = 80, targetPort = 80;
      if (tcpFlag) { const [p1, p2] = tcpFlag.slice(6).split(':'); port = parseInt(p1) || 80; targetPort = p2 ? (parseInt(p2) || port) : port; }
      e.createService(name, name, port, type, ns);
      const s = e.findService(name, ns); if (s) s.targetPort = targetPort;
      print(`service/${name} created`, 'ok'); sfx('net-connect'); after(true); return;
    }
    print(`error: 不支持 create ${kind || '(空)'}（支持 deployment / namespace / configmap / secret / service）`, 'err');
    sfx('err-syntax'); after(false);
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
    // kubectl delete pod|deployment|service <名> · --all · -l key=value · -f <文件.yaml>
    const all = rest.includes('--all');
    if (all) rest.splice(rest.indexOf('--all'), 1);
    // -l / --selector：按标签批量删除
    let sel = '';
    const li = rest.indexOf('-l');
    if (li >= 0 && rest[li + 1]) { sel = rest[li + 1]; rest.splice(li, 2); }
    const selLong = rest.findIndex(a => a.startsWith('--selector='));
    if (selLong >= 0) { sel = rest[selLong].split('=')[1]; rest.splice(selLong, 1); }
    const fi = rest.indexOf('-f');
    if (fi >= 0) {
      const file = rest[fi + 1];
      if (!file) { print('用法：kubectl delete -f <文件.yaml>', 'err'); sfx('err-syntax'); after(false); return; }
      const r = e.readFile(file);
      if (r.err) { print(`error: the path "${file}" does not exist`, 'err'); sfx('err-syntax'); after(false); return; }
      const m = e.parseManifest(r.content);
      const kind = (m.kind || '').toLowerCase();
      const name = m.name;
      const mns = m.namespace || ns;
      if (!name) { print('error: manifest 缺少 name', 'err'); sfx('err-syntax'); after(false); return; }
      let ok = false, doneMsg = '', notFound = '';
      if (kind === 'deployment' || kind === 'deployments') {
        ok = e.deleteDeployment(name, mns);
        doneMsg = `deployment.apps "${name}" deleted`; notFound = `Error from server (NotFound): deployments "${name}" not found`;
      } else if (kind === 'pod' || kind === 'pods') {
        ok = e.deletePod(name, mns);
        doneMsg = `pod "${name}" deleted`; notFound = `Error from server (NotFound): pods "${name}" not found`;
      } else if (kind === 'service' || kind === 'services') {
        ok = e.deleteService(name, mns);
        doneMsg = `service "${name}" deleted`; notFound = `Error from server (NotFound): services "${name}" not found`;
      } else {
        print(`error: 不支持的 kind "${m.kind || '(空)'}"（支持 Pod / Deployment / Service）`, 'err');
        sfx('err-syntax'); after(false); return;
      }
      print(ok ? doneMsg : notFound, ok ? 'ok' : 'err');
      sfx(ok ? 'ui-close' : 'err-syntax'); after(ok); return;
    }
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const isPod = kind === 'pod' || kind === 'pods' || kind === 'po';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    const isSvc = kind === 'service' || kind === 'services' || kind === 'svc';
    if (sel) {
      if (isPod) {
        const list = e.pods.filter(p => p.namespace === ns && matchSelector(p, sel));
        if (!list.length) { print('No resources found in ' + ns + ' namespace.', 'info'); after(false); return; }
        for (const p of list) { e.deletePod(p.name, ns); print(`pod "${p.name}" deleted`, 'ok'); }
        sfx('ui-close'); after(true); return;
      }
      if (isDep) {
        const list = e.deployments.filter(d => d.namespace === ns && matchSelector(d, sel));
        if (!list.length) { print('No resources found in ' + ns + ' namespace.', 'info'); after(false); return; }
        for (const d of list) { e.deleteDeployment(d.name, ns); print(`deployment.apps "${d.name}" deleted`, 'ok'); }
        sfx('ui-close'); after(true); return;
      }
      print('error: -l 选择器删除暂只支持 pods / deployments', 'err'); sfx('err-syntax'); after(false); return;
    }
    if (all) {
      if (isPod) {
        const list = e.pods.filter(p => p.namespace === ns);
        if (!list.length) { print('No resources found in ' + ns + ' namespace.', 'info'); after(false); return; }
        for (const p of list) { e.deletePod(p.name, ns); print(`pod "${p.name}" deleted`, 'ok'); }
        sfx('ui-close'); after(true); return;
      }
      if (isDep) {
        const list = e.deployments.filter(d => d.namespace === ns);
        if (!list.length) { print('No resources found in ' + ns + ' namespace.', 'info'); after(false); return; }
        for (const d of list) { e.deleteDeployment(d.name, ns); print(`deployment.apps "${d.name}" deleted`, 'ok'); }
        sfx('ui-close'); after(true); return;
      }
      if (isSvc) {
        const list = e.services.filter(s => s.namespace === ns);
        if (!list.length) { print('No resources found in ' + ns + ' namespace.', 'info'); after(false); return; }
        for (const s of list) { e.deleteService(s.name, ns); print(`service "${s.name}" deleted`, 'ok'); }
        sfx('ui-close'); after(true); return;
      }
      print('error: --all 暂只支持 pods / deployments / services', 'err'); sfx('err-syntax'); after(false); return;
    }
    if (!name) { print('用法：kubectl delete pod|deployment <名>（或 --all / -l key=value / -f <文件.yaml>）', 'err'); sfx('err-syntax'); after(false); return; }
    if (isPod) {
      if (e.deletePod(name, ns)) { print(`pod "${name}" deleted`, 'ok'); sfx('ui-close'); after(true); }
      else { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); }
    } else if (isDep) {
      if (e.deleteDeployment(name, ns)) { print(`deployment.apps "${name}" deleted`, 'ok'); sfx('ui-close'); after(true); }
      else { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); }
    } else if (isSvc) {
      if (e.deleteService(name, ns)) { print(`service "${name}" deleted`, 'ok'); sfx('ui-close'); after(true); }
      else { print(`Error from server (NotFound): services "${name}" not found`, 'err'); sfx('err-syntax'); after(false); }
    } else {
      print(`error: 暂只支持 delete pod|deployment|service`, 'err'); sfx('err-syntax'); after(false);
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
      e.createDeployment(m.name, m.image, parseInt(m.replicas) || 1, ns, m.labels || null);
      const d = e.findDeployment(m.name, ns); if (d) e.bumpRevision(d, 'apply');
      print(`deployment.apps/${m.name} configured`, 'ok');
    } else if (kind === 'service') {
      if (!m.name) { print('error: manifest 缺少 name', 'err'); sfx('err-syntax'); after(false); return; }
      e.createService(m.name, m.target || m.name, parseInt(m.port) || 80, m.type || 'ClusterIP', ns, m.labels || null);
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

  rollout(rest, e, ns) {
    // kubectl rollout status|restart|history|undo deployment/<名>（也接受 deployment <名>）
    const action = (rest[0] || '').toLowerCase();
    const target = rest[1] || '';
    let kind, name;
    if (target.includes('/')) { [kind, name] = target.split('/'); }
    else { kind = target; name = rest[2] || ''; }
    kind = (kind || '').toLowerCase();
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if (!isDep || !name) {
      print('用法：kubectl rollout status|restart|history|undo deployment/<名>', 'err'); sfx('err-syntax'); after(false); return;
    }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    if (action === 'status') {
      const ready = e.podsOfDeployment(d.name, ns).filter(p => p.status === 'Running').length;
      const ok = ready >= d.replicas;
      const line = ok
        ? `deployment "${d.name}" successfully rolled out`
        : `Waiting for deployment "${d.name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...`;
      print(line, ok ? 'ok' : 'warn');
      e.lastOut = line;
      sfx('text-grep'); after(true);
    } else if (action === 'restart') {
      // restart：销毁旧 Pod，控制器重建一批新的（名字/编号全新，数量不变）
      e.pods = e.pods.filter(p => !(p.namespace === ns && p.owner === d.name));
      e._reconcile(d);
      e.bumpRevision(d, 'restart');
      print(`deployment.apps/${d.name} restarted`, 'ok');
      sfx('net-connect'); after(true);
    } else if (action === 'history') {
      const revFlag = rest.find(a => a.startsWith('--revision='));
      const out = [`deployment.apps/${d.name}`, 'REVISION  CHANGE-CAUSE'];
      const hist = (d.history && d.history.length) ? d.history : [{ revision: d.revision || 1, change: 'create' }];
      if (revFlag) {
        const rv = parseInt(revFlag.split('=')[1]);
        const h = hist.find(x => x.revision === rv);
        if (!h) { print(`Error from server (NotFound): replicasets "${d.name}-${rv}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
        out.push(`# revision ${h.revision}`, `Image:    ${h.image}`, `Replicas: ${h.replicas}`);
      } else {
        for (const h of hist) out.push(pad(String(h.revision), 10) + (h.change || '<none>'));
      }
      out.forEach(l => print(l, 'out'));
      e.lastOut = out.join('\n');
      sfx('text-grep'); after(true);
    } else if (action === 'undo') {
      const revFlag = rest.find(a => a.startsWith('--to-revision='));
      const hist = d.history || [];
      if (!hist.length) { print(`skipped rollout (no change): deployment.apps/${d.name}`, 'info'); after(false); return; }
      let target2;
      if (revFlag) {
        const rv = parseInt(revFlag.split('=')[1]);
        target2 = hist.find(x => x.revision === rv);
        if (!target2) { print(`Error from server (NotFound): replicasets "${d.name}-${rv}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      } else target2 = hist[hist.length - 1];
      d.image = target2.image; d.replicas = target2.replicas;
      e.pods = e.pods.filter(p => !(p.namespace === ns && p.owner === d.name));
      e._reconcile(d);
      e.bumpRevision(d, `undo→r${target2.revision}`);
      print(`deployment.apps/${d.name} rolled back`, 'ok');
      sfx('net-connect'); after(true);
    } else {
      print('用法：kubectl rollout status|restart|history|undo deployment/<名>', 'err'); sfx('err-syntax'); after(false);
    }
  },

  patch(rest, e, ns) {
    // kubectl patch deployment <名> -p '{"spec":{"replicas":3}}'（简：支持 replicas / image）
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if (!isDep || !name) { print('用法：kubectl patch deployment <名> -p \'{"spec":{"replicas":3}}\'', 'err'); sfx('err-syntax'); after(false); return; }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    let pStr = '';
    const pi = rest.findIndex(a => a.startsWith('-p='));
    if (pi >= 0) pStr = rest[pi].slice(3);
    else { const p2 = rest.findIndex(a => a === '-p' || a === '--patch'); if (p2 >= 0 && rest[p2 + 1]) pStr = rest[p2 + 1]; }
    if (!pStr) { print('用法：kubectl patch deployment <名> -p \'{"spec":{"replicas":3}}\'', 'err'); sfx('err-syntax'); after(false); return; }
    let obj;
    try { obj = JSON.parse(pStr); } catch (err) { print(`error: unable to parse "${pStr}" as JSON patch`, 'err'); sfx('err-syntax'); after(false); return; }
    const spec = (obj && obj.spec) || obj || {};
    const tmpl = spec.template || {};
    const replicas = spec.replicas !== undefined ? spec.replicas
      : (tmpl.spec && tmpl.spec.replicas !== undefined ? tmpl.spec.replicas : undefined);
    let image;
    if (spec.image) image = spec.image;
    else if (tmpl.spec && tmpl.spec.containers && tmpl.spec.containers[0] && tmpl.spec.containers[0].image) image = tmpl.spec.containers[0].image;
    if (replicas === undefined && image === undefined) { print('error: patch 未包含可识别字段（支持 spec.replicas / image）', 'err'); sfx('err-syntax'); after(false); return; }
    if (replicas !== undefined) { d.replicas = parseInt(replicas) || d.replicas; e._reconcile(d); }
    if (image !== undefined) { d.image = image; e.pods = e.pods.filter(p => !(p.namespace === ns && p.owner === d.name)); e._reconcile(d); }
    e.bumpRevision(d, 'patch');
    print(`deployment.apps/${d.name} patched`, 'ok');
    sfx('net-connect'); after(true);
  },

  set(rest, e, ns) {
    // kubectl set image deployment/<名> <容器>=<镜像>
    const what = (rest[0] || '').toLowerCase();
    if (what !== 'image') { print('用法：kubectl set image deployment/<名> <容器>=<镜像>', 'err'); sfx('err-syntax'); after(false); return; }
    const target = rest[1] || '';
    let kind, name;
    if (target.includes('/')) { [kind, name] = target.split('/'); }
    else { kind = target; name = rest[2] || ''; }
    kind = (kind || '').toLowerCase();
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    const pair = rest.find(a => a.includes('=') && !a.startsWith('-'));
    if (!isDep || !name || !pair) { print('用法：kubectl set image deployment/<名> <容器>=<镜像>', 'err'); sfx('err-syntax'); after(false); return; }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    d.image = pair.split('=').slice(1).join('=');
    e.pods = e.pods.filter(p => !(p.namespace === ns && p.owner === d.name));
    e._reconcile(d);
    e.bumpRevision(d, 'set-image');
    print(`deployment.apps/${d.name} image updated`, 'ok');
    sfx('net-connect'); after(true);
  },

  autoscale(rest, e, ns) {
    // kubectl autoscale deployment <名> --min=2 --max=5 [--cpu-percent=80]
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if (!isDep || !name) { print('用法：kubectl autoscale deployment <名> --min=2 --max=5 [--cpu-percent=80]', 'err'); sfx('err-syntax'); after(false); return; }
    const d = e.findDeployment(name, ns);
    if (!d) { print(`Error from server (NotFound): deployments "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const minFlag = rest.find(a => a.startsWith('--min='));
    const maxFlag = rest.find(a => a.startsWith('--max='));
    const cpuFlag = rest.find(a => a.startsWith('--cpu-percent='));
    const min = minFlag ? parseInt(minFlag.split('=')[1]) : 1;
    const max = maxFlag ? parseInt(maxFlag.split('=')[1]) : d.replicas;
    const cpu = cpuFlag ? parseInt(cpuFlag.split('=')[1]) : 80;
    e.hpas.push({ name: d.name, namespace: ns, target: d.name, min, max, cpu });
    print(`horizontalpodautoscaler.autoscaling/${d.name} autoscaled`, 'ok');
    sfx('net-connect'); after(true);
  },

  cordon(rest, e) {
    const name = rest[0];
    const node = e.nodes.find(n => n.name === name) || e.nodes.find(n => n.name.startsWith(name));
    if (!node) { print(`Error from server (NotFound): nodes "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    node.unschedulable = true;
    print(`node/${node.name} cordoned`, 'ok'); sfx('net-connect'); after(true);
  },

  uncordon(rest, e) {
    const name = rest[0];
    const node = e.nodes.find(n => n.name === name) || e.nodes.find(n => n.name.startsWith(name));
    if (!node) { print(`Error from server (NotFound): nodes "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    node.unschedulable = false;
    print(`node/${node.name} uncordoned`, 'ok'); sfx('net-connect'); after(true);
  },

  drain(rest, e) {
    // kubectl drain <节点> [--ignore-daemonsets] [--delete-emptydir-data] [--force]
    const name = rest.find(a => !a.startsWith('-'));
    const node = e.nodes.find(n => n.name === name) || e.nodes.find(n => n.name.startsWith(name));
    if (!node) { print(`Error from server (NotFound): nodes "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const force = takeFlag(rest, '--force');
    const out = [`node/${node.name} already cordoned`, `evicting pods from node ${node.name} ...`];
    const victims = e.pods.filter(p => p.node === node.name);
    for (const p of victims) {
      if (p.owner) out.push(`evicting pod ${p.namespace}/${p.name}`);
      else if (force) out.push(`evicting pod ${p.namespace}/${p.name}`);
    }
    // 驱逐：删除该节点上的 Pod（Deployment 控制器会在其它节点重建）
    e.pods = e.pods.filter(p => p.node !== node.name);
    for (const d of e.deployments) e._reconcile(d);
    node.unschedulable = true;
    out.push(`node/${node.name} drained`);
    out.forEach(l => print(l, 'ok'));
    e.lastOut = out.join('\n');
    sfx('net-connect'); after(true);
  },

  taint(rest, e) {
    // kubectl taint nodes <节点> key=value:Effect | kubectl taint nodes <节点> key:Effect-
    const kind = (rest[0] || '').toLowerCase();
    const nodeName = rest[1];
    const spec = rest[2];
    if ((kind !== 'nodes' && kind !== 'node' && kind !== 'no') || !nodeName || !spec) {
      print('用法：kubectl taint nodes <节点> key=value:Effect（移除：key:Effect-）', 'err'); sfx('err-syntax'); after(false); return;
    }
    const node = e.nodes.find(n => n.name === nodeName) || e.nodes.find(n => n.name.startsWith(nodeName));
    if (!node) { print(`Error from server (NotFound): nodes "${nodeName}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    node.taints = node.taints || [];
    if (spec.endsWith('-')) {
      const key = spec.slice(0, -1).split(':')[0];
      const before = node.taints.length;
      node.taints = node.taints.filter(t => t.split('=')[0] !== key);
      if (node.taints.length === before) { print(`error: taint "${key}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      print(`node/${node.name} untainted`, 'ok'); sfx('net-connect'); after(true); return;
    }
    const m = spec.match(/^([^=:]+)(?:=([^:]*))?:([A-Za-z]+)$/);
    if (!m) { print('error: taint 需形如 key=value:Effect（Effect 如 NoSchedule / PreferNoSchedule / NoExecute）', 'err'); sfx('err-syntax'); after(false); return; }
    node.taints = node.taints.filter(t => t.split('=')[0] !== m[1]);
    node.taints.push(`${m[1]}=${m[2] || ''}:${m[3]}`);
    print(`node/${node.name} tainted`, 'ok'); sfx('net-connect'); after(true);
  },

  config(rest, e) {
    const action = (rest[0] || '').toLowerCase();
    const contexts = ['default-context', 'prod-cluster', 'staging'];
    if (action === 'view') {
      const out = [
        'apiVersion: v1', 'kind: Config', 'current-context: ' + (e.currentContext || 'default-context'),
        'clusters:', '- cluster:', '    server: https://10.0.0.1:6443', '  name: termquest-cluster',
        'contexts:', ...contexts.map(c => `- context:\n    cluster: termquest-cluster\n    user: admin\n  name: ${c}`),
        'users:', '- name: admin', '  user: {}',
      ];
      out.forEach(l => print(l, 'out'));
      e.lastOut = out.join('\n'); sfx('text-grep'); after(true); return;
    }
    if (action === 'current-context') {
      print(e.currentContext || 'default-context', 'out');
      e.lastOut = e.currentContext || 'default-context'; sfx('text-grep'); after(true); return;
    }
    if (action === 'get-contexts') {
      const out = [pad('CURRENT', 9) + pad('NAME', 18) + pad('CLUSTER', 18) + 'AUTHINFO'];
      for (const c of contexts)
        out.push(pad(c === e.currentContext ? '*' : '', 9) + pad(c, 18) + pad('termquest-cluster', 18) + 'admin');
      out.forEach(l => print(l, 'out'));
      e.lastOut = out.join('\n'); sfx('text-grep'); after(true); return;
    }
    if (action === 'use-context') {
      const name = rest[1];
      if (!name) { print('用法：kubectl config use-context <上下文名>', 'err'); sfx('err-syntax'); after(false); return; }
      e.currentContext = name;
      print(`Switched to context "${name}".`, 'ok'); sfx('net-connect'); after(true); return;
    }
    print('用法：kubectl config view|current-context|get-contexts|use-context <名>', 'err'); sfx('err-syntax'); after(false);
  },

  'api-resources'(_rest, e) {
    const rows = [
      ['pods', 'po', 'v1', 'true', 'Pod'],
      ['services', 'svc', 'v1', 'true', 'Service'],
      ['namespaces', 'ns', 'v1', 'false', 'Namespace'],
      ['nodes', 'no', 'v1', 'false', 'Node'],
      ['configmaps', 'cm', 'v1', 'true', 'ConfigMap'],
      ['secrets', '', 'v1', 'true', 'Secret'],
      ['events', 'ev', 'v1', 'true', 'Event'],
      ['deployments', 'deploy', 'apps/v1', 'true', 'Deployment'],
      ['replicasets', 'rs', 'apps/v1', 'true', 'ReplicaSet'],
      ['horizontalpodautoscalers', 'hpa', 'autoscaling/v2', 'true', 'HorizontalPodAutoscaler'],
    ];
    const out = [pad('NAME', 26) + pad('SHORTNAMES', 13) + pad('APIVERSION', 18) + pad('NAMESPACED', 12) + 'KIND'];
    for (const r of rows) out.push(pad(r[0], 26) + pad(r[1], 13) + pad(r[2], 18) + pad(r[3], 12) + r[4]);
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n'); sfx('text-grep'); after(true);
  },

  'api-versions'(_rest, e) {
    const vers = ['admissionregistration.k8s.io/v1', 'apps/v1', 'autoscaling/v2', 'batch/v1', 'certificates.k8s.io/v1', 'networking.k8s.io/v1', 'policy/v1', 'rbac.authorization.k8s.io/v1', 'storage.k8s.io/v1', 'v1'];
    vers.forEach(l => print(l, 'out'));
    e.lastOut = vers.join('\n'); sfx('text-grep'); after(true);
  },

  explain(rest, e) {
    const kind = (rest[0] || '').toLowerCase();
    const FIELDS = {
      pod: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
      deployment: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
      service: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
      node: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
      namespace: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
      configmap: ['apiVersion', 'kind', 'metadata', 'data'],
      secret: ['apiVersion', 'kind', 'metadata', 'data', 'type'],
    };
    const KINDNAME = { pod: 'Pod', deployment: 'Deployment', service: 'Service', node: 'Node', namespace: 'Namespace', configmap: 'ConfigMap', secret: 'Secret', hpa: 'HorizontalPodAutoscaler' };
    const key = kind === 'pods' ? 'pod' : kind === 'deployments' || kind === 'deploy' ? 'deployment'
      : kind === 'services' || kind === 'svc' ? 'service' : kind === 'nodes' || kind === 'no' ? 'node'
      : kind === 'namespaces' || kind === 'ns' ? 'namespace' : kind === 'configmaps' || kind === 'cm' ? 'configmap'
      : kind === 'secrets' ? 'secret' : kind;
    if (!kind) { print('用法：kubectl explain <资源类型>，如 kubectl explain pod', 'err'); sfx('err-syntax'); after(false); return; }
    if (!FIELDS[key] && !KINDNAME[key]) { print(`error: the server doesn't have a resource type "${kind}"`, 'err'); sfx('err-syntax'); after(false); return; }
    const out = [`KIND:     ${KINDNAME[key] || kind}`, `VERSION:  v1`, '', 'DESCRIPTION:', `     ${KINDNAME[key] || kind} 是 Kubernetes 的核心资源对象。`, '', 'FIELDS:'];
    for (const f of (FIELDS[key] || ['apiVersion', 'kind', 'metadata'])) out.push(`   ${f}  <Object>`);
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n'); sfx('text-grep'); after(true);
  },

  wait(rest, e, ns) {
    // kubectl wait --for=condition=Ready pod/<名> --timeout=30s（模拟：立即判定）
    let forWhat = '';
    const fi = rest.findIndex(a => a.startsWith('--for='));
    if (fi >= 0) { forWhat = rest[fi].slice(6); rest.splice(fi, 1); }
    let timeout = '30s';
    const ti = rest.findIndex(a => a.startsWith('--timeout='));
    if (ti >= 0) { timeout = rest[ti].slice(10); rest.splice(ti, 1); }
    const target = rest.find(a => !a.startsWith('-')) || '';
    let kind = '', name = '';
    if (target.includes('/')) { [kind, name] = target.split('/'); }
    else { kind = target; name = rest.filter(a => !a.startsWith('-'))[1] || ''; }
    kind = (kind || '').toLowerCase();
    if (!target) { print('用法：kubectl wait --for=condition=Ready pod/<名> [--timeout=30s]', 'err'); sfx('err-syntax'); after(false); return; }
    let found = null, label = target;
    if (kind === 'pod' || kind === 'pods' || kind === 'po') { found = e.findPod(name, ns); label = `pod/${name}`; }
    else if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') { found = e.findDeployment(name, ns); label = `deployment.apps/${name}`; }
    else if (kind === 'node' || kind === 'nodes' || kind === 'no') { found = e.nodes.find(n => n.name === name); label = `node/${name}`; }
    else { found = { name }; }
    if ((kind === 'pod' || kind === 'pods' || kind === 'po' || kind === 'deployment' || kind === 'deployments' || kind === 'deploy') && !found) {
      print(`Error from server (NotFound): ${kind} "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return;
    }
    const line = `${label} condition met`;
    print(line, 'ok'); print(`(等待 ${forWhat || 'condition'}，超时 ${timeout} —— 模拟立即满足)`, 'info');
    e.lastOut = line; sfx('text-grep'); after(true);
  },

  auth(rest, e, ns) {
    // kubectl auth can-i <动作> <资源> [--as=用户]
    const action = (rest[0] || '').toLowerCase();
    if (action !== 'can-i') { print('用法：kubectl auth can-i <动作> <资源>', 'err'); sfx('err-syntax'); after(false); return; }
    const verb = rest[1];
    const resource = rest[2];
    if (!verb || !resource) { print('用法：kubectl auth can-i <动作> <资源>，如 kubectl auth can-i create pods', 'err'); sfx('err-syntax'); after(false); return; }
    const asFlag = rest.find(a => a.startsWith('--as='));
    const who = asFlag ? asFlag.split('=')[1] : 'system:admin';
    const answer = who.includes('admin') || who === 'user' ? 'yes' : 'no';
    print(answer, 'out');
    e.lastOut = answer; sfx('text-grep'); after(true);
  },

  edit(rest, e, ns) {
    // kubectl edit pod|deployment <名>（模拟：提示在编辑器中打开）
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const isPod = kind === 'pod' || kind === 'pods' || kind === 'po';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    const isSvc = kind === 'service' || kind === 'services' || kind === 'svc';
    if ((!isPod && !isDep && !isSvc) || !name) { print('用法：kubectl edit pod|deployment|service <名>', 'err'); sfx('err-syntax'); after(false); return; }
    let obj = null;
    if (isPod) obj = e.findPod(name, ns);
    else if (isDep) obj = e.findDeployment(name, ns);
    else obj = e.findService(name, ns);
    if (!obj) { print(`Error from server (NotFound): ${kind} "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const out = [
      `# 在编辑器（vim）中打开 ${kind}/${obj.name} 的 YAML`,
      '# 保存退出 (:wq) 后应用更改；TermQuest 中已模拟保存，未做实际修改。',
      `# 提示：直接修改请用 kubectl patch / set image / scale / label`,
    ];
    out.forEach(l => print(l, 'info'));
    e.lastOut = out.join('\n'); sfx('text-grep'); after(true);
  },

  annotate(rest, e, ns) {
    // kubectl annotate pod|deployment <名> key=value [--overwrite]
    const overwrite = takeFlag(rest, '--overwrite');
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const pairs = rest.slice(2).filter(a => !a.startsWith('-') && a.includes('='));
    const isPod = kind === 'pod' || kind === 'pods' || kind === 'po';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if ((!isPod && !isDep) || !name || !pairs.length) {
      print('用法：kubectl annotate pod|deployment <名> key=value [--overwrite]', 'err'); sfx('err-syntax'); after(false); return;
    }
    const obj = isPod ? e.findPod(name, ns) : e.findDeployment(name, ns);
    if (!obj) {
      print(`Error from server (NotFound): ${isPod ? 'pods' : 'deployments'} "${name}" not found`, 'err');
      sfx('err-syntax'); after(false); return;
    }
    obj.annotations = obj.annotations || {};
    for (const kv of pairs) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (obj.annotations[k] !== undefined && obj.annotations[k] !== v && !overwrite) {
        print(`error: 'annotations' already has a value for '${k}', and --overwrite is false`, 'err');
        sfx('err-syntax'); after(false); return;
      }
      obj.annotations[k] = v;
    }
    print(`${isPod ? 'pod' : 'deployment.apps'}/${obj.name} annotated`, 'ok');
    sfx('net-connect'); after(true);
  },

  label(rest, e, ns) {
    // kubectl label pod|deployment <名> key=value [key2=value2 ...] [--overwrite]
    const overwrite = takeFlag(rest, '--overwrite');
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const pairs = rest.slice(2).filter(a => !a.startsWith('-') && a.includes('='));
    const isPod = kind === 'pod' || kind === 'pods' || kind === 'po';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if ((!isPod && !isDep) || !name || !pairs.length) {
      print('用法：kubectl label pod|deployment <名> key=value [--overwrite]', 'err'); sfx('err-syntax'); after(false); return;
    }
    const obj = isPod ? e.findPod(name, ns) : e.findDeployment(name, ns);
    if (!obj) {
      print(`Error from server (NotFound): ${isPod ? 'pods' : 'deployments'} "${name}" not found`, 'err');
      sfx('err-syntax'); after(false); return;
    }
    obj.labels = obj.labels || {};
    for (const kv of pairs) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (obj.labels[k] !== undefined && obj.labels[k] !== v && !overwrite) {
        print(`error: 'labels' already has a value for '${k}', and --overwrite is false`, 'err');
        sfx('err-syntax'); after(false); return;
      }
      obj.labels[k] = v;
    }
    print(`${isPod ? 'pod' : 'deployment.apps'}/${obj.name} labeled`, 'ok');
    sfx('net-connect'); after(true);
  },

  cp(rest, e, ns) {
    // kubectl cp <pod>:<远程路径> <本地路径> | kubectl cp <本地路径> <pod>:<远程路径>
    const args = rest.filter(a => !a.startsWith('-'));
    const src = args[0], dst = args[1];
    if (!src || !dst) { print('用法：kubectl cp <pod>:<远程路径> <本地路径>（或反向）', 'err'); sfx('err-syntax'); after(false); return; }
    const parse = s => { const i = s.indexOf(':'); return i >= 0 ? { pod: s.slice(0, i), path: s.slice(i + 1) } : { pod: null, path: s }; };
    const s = parse(src), d = parse(dst);
    if (s.pod) {
      const p = e.findPod(s.pod, ns);
      if (!p) { print(`Error from server (NotFound): pods "${s.pod}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      const r = e.readFile(s.path);
      if (r.err) { print(`error: source "${s.path}" not found in pod ${p.name}`, 'err'); sfx('err-syntax'); after(false); return; }
      e.writeFile(d.path, r.content);
      print(`tar: 已从 ${p.name}:${s.path} 拷贝到 ${d.path}`, 'ok'); sfx('file-copy'); after(true); return;
    }
    if (d.pod) {
      const p = e.findPod(d.pod, ns);
      if (!p) { print(`Error from server (NotFound): pods "${d.pod}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
      const r = e.readFile(s.path);
      if (r.err) { print(`error: source "${s.path}" does not exist`, 'err'); sfx('err-syntax'); after(false); return; }
      print(`tar: 已拷贝 ${s.path} 到 ${p.name}:${d.path}`, 'ok'); sfx('file-copy'); after(true); return;
    }
    print('用法：kubectl cp 需要 <pod>:<路径> 作为源或目标', 'err'); sfx('err-syntax'); after(false);
  },

  'port-forward'(rest, e, ns) {
    // kubectl port-forward pod|deployment|service/<名> 8080:80（模拟）
    const target = rest.find(a => !a.startsWith('-')) || '';
    const ports = rest.filter(a => !a.startsWith('-'))[1] || '';
    let kind = '', name = '';
    if (target.includes('/')) { [kind, name] = target.split('/'); }
    else { kind = target; name = rest.filter(a => !a.startsWith('-'))[1] || ''; }
    kind = (kind || '').toLowerCase();
    if (!name) { print('用法：kubectl port-forward pod|deployment|service/<名> 8080:80', 'err'); sfx('err-syntax'); after(false); return; }
    let obj = null, label = target;
    if (kind === 'pod' || kind === 'pods' || kind === 'po') { obj = e.findPod(name, ns); label = `pod/${name}`; }
    else if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') { obj = e.findDeployment(name, ns); label = `deployment/${name}`; }
    else if (kind === 'service' || kind === 'services' || kind === 'svc') { obj = e.findService(name, ns); label = `service/${name}`; }
    else { obj = e.findPod(name, ns) || e.findDeployment(name, ns) || e.findService(name, ns); }
    if (!obj) { print(`Error from server (NotFound): ${kind || '资源'} "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    let local = '8080', remote = '80';
    if (ports) { const [a, b] = ports.split(':'); local = a; remote = b || a; }
    const out = [
      `Forwarding from 127.0.0.1:${local} -> ${remote}`,
      `Forwarding from [::1]:${local} -> ${remote}`,
      `(port-forward ${label}：TermQuest 模拟，Ctrl-C 停止)`,
    ];
    out.forEach(l => print(l, 'out'));
    e.lastOut = out.join('\n'); sfx('net-connect'); after(true);
  },

  top(rest, e, ns) {
    // kubectl top pods|nodes —— 模拟 metrics-server 的用量报告
    const what = (rest[0] || '').toLowerCase();
    const out = [];
    if (what === 'pods' || what === 'pod' || what === 'po') {
      const list = e.pods.filter(p => p.namespace === ns);
      out.push(pad('NAME', 26) + pad('CPU(cores)', 13) + 'MEMORY(bytes)');
      for (const p of list) {
        const h = hashStr(p.name);
        out.push(pad(p.name, 26) + pad(`${(h % 45) + 1}m`, 13) + `${(h % 180) + 24}Mi`);
      }
      if (!list.length) out.push('No resources found in ' + ns + ' namespace.');
    } else if (what === 'nodes' || what === 'node' || what === 'no') {
      out.push(pad('NAME', 10) + pad('CPU(cores)', 12) + pad('CPU%', 8) + pad('MEMORY(bytes)', 15) + 'MEMORY%');
      for (const n of e.nodes) {
        const h = hashStr(n.name);
        const cores = parseInt(n.cpu) || 4;
        const memGi = parseInt(n.mem) || 16;
        const cpuPct = (h % 40) + 8, memPct = (h % 45) + 15;
        out.push(pad(n.name, 10) + pad(`${Math.round(cores * 1000 * cpuPct / 100)}m`, 12) + pad(cpuPct + '%', 8)
          + pad(`${Math.round(memGi * 1024 * memPct / 100)}Mi`, 15) + memPct + '%');
      }
    } else {
      print('用法：kubectl top pods|nodes', 'err'); sfx('err-syntax'); after(false); return;
    }
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

/* ---- 辅助：哈希 / 标签选择器 / 字段选择器 / 排序 / 简易 YAML 序列化 ---- */
function hashStr(s) { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

// 取出并移除一个布尔开关（-f / --watch / --overwrite ...）
function takeFlag(rest, flag) {
  const i = rest.indexOf(flag);
  if (i >= 0) { rest.splice(i, 1); return true; }
  return false;
}

// -l 选择器：支持 key（存在性）与 key=value，逗号分隔需全部满足
function matchSelector(o, sel) {
  const labels = o.labels || {};
  return String(sel).split(',').every(kv => {
    if (!kv) return true;
    const i = kv.indexOf('=');
    return i < 0 ? labels[kv] !== undefined : labels[kv.slice(0, i)] === kv.slice(i + 1);
  });
}

// --field-selector：支持 metadata.name / metadata.namespace / status.phase（pod）
function matchFieldSelector(o, sel, isPod) {
  return String(sel).split(',').every(kv => {
    if (!kv) return true;
    const i = kv.indexOf('=');
    if (i < 0) return true;
    const key = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
    if (key === 'metadata.name') return o.name === val;
    if (key === 'metadata.namespace') return o.namespace === val;
    if (key === 'status.phase') return isPod ? o.status === val : true;
    return true;
  });
}

// --sort-by：支持 .metadata.name / metadata.name / status / replicas 等
function sortByField(spec) {
  const key = String(spec).replace(/^\./, '').replace(/^metadata\./, '').replace(/^spec\./, '').replace(/^status\./, '');
  return (a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av === undefined ? '' : av).localeCompare(String(bv === undefined ? '' : bv));
  };
}

// 输出前清理内部字段（下划线开头 + revision/history），让 -o yaml/json 更贴近真实
function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_') || k === 'history' || k === 'revision') continue;
    r[k] = v;
  }
  return r;
}

// 收集 configmap/secret 的数据：--from-literal=k=v[,k2=v2] / --from-file=<文件>
function collectData(rest, e) {
  const data = {};
  for (const a of rest) {
    if (a.startsWith('--from-literal=')) Object.assign(data, parseLabels(a.slice('--from-literal='.length)));
    else if (a.startsWith('--from-file=')) {
      const path = a.slice('--from-file='.length);
      const r = e.readFile(path);
      data[e.basename ? e.basename(path) : path] = r.ok ? r.content.trim() : '';
    }
  }
  return data;
}

// "k=v,k2=v2" → { k: 'v', k2: 'v2' }（无 = 的值视为 "true"）
function parseLabels(str) {
  const labels = {};
  for (const kv of String(str).split(',')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i < 0) labels[kv] = 'true'; else labels[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return labels;
}

// { app: 'web', tier: 'fe' } → "app=web,tier=fe"
function selStr(o) { return o.labels ? Object.entries(o.labels).map(([k, v]) => `${k}=${v}`).join(',') : ''; }

// 极简 YAML 序列化（-o yaml 用）：支持嵌套对象、字符串数组
function toYaml(obj, indent = 0) {
  const sp = '  '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) { lines.push(`${sp}${k}: null`); continue; }
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${sp}${k}: []`); continue; }
      lines.push(`${sp}${k}:`);
      for (const it of v) lines.push(`${sp}- ${typeof it === 'string' ? yamlScalar(it) : String(it)}`);
    } else if (typeof v === 'object') {
      lines.push(`${sp}${k}:`);
      lines.push(toYaml(v, indent + 1));
    } else if (typeof v === 'string') {
      lines.push(`${sp}${k}: ${yamlScalar(v)}`);
    } else lines.push(`${sp}${k}: ${v}`);
  }
  return lines.join('\n');
}
function yamlScalar(s) { return /[:#\s]|^$/.test(s) ? JSON.stringify(s) : s; }
