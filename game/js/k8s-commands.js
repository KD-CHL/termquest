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
      '  kubectl get all · kubectl describe pod <名> · kubectl logs <pod> [--tail=N]',
      '  kubectl get pod <名> · get pods -o wide|-o yaml|-o json|-o name',
      '  kubectl get pods -l key=value · kubectl top pods|nodes',
      '── kubectl 操作 ──',
      '  kubectl create deployment <名> --image=<镜像> [--replicas=N]',
      '  kubectl run <pod名> --image=<镜像> [--labels=k=v,k2=v2]',
      '  kubectl scale deployment <名> --replicas=N',
      '  kubectl expose deployment <名> --port=80 [--type=NodePort]',
      '  kubectl rollout status|restart deployment/<名>',
      '  kubectl label pod|deployment <名> key=value',
      '  kubectl apply -f <文件.yaml> · kubectl delete pod|deployment <名>',
      '  kubectl delete pods|deployments --all · kubectl delete -f <文件.yaml>',
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
    const wide = fmt === 'wide';

    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const out = [];

    const isPod = kind === 'pods' || kind === 'pod' || kind === 'po';
    const isDep = kind === 'deployments' || kind === 'deployment' || kind === 'deploy';
    const isSvc = kind === 'services' || kind === 'service' || kind === 'svc';
    const isNode = kind === 'nodes' || kind === 'node' || kind === 'no';
    const isNs = kind === 'namespaces' || kind === 'namespace' || kind === 'ns';

    if (isPod || isDep || isSvc || isNode || isNs) {
      let objs, prefix;
      if (isPod) { objs = e.pods.filter(p => p.namespace === ns); prefix = 'pod'; }
      else if (isDep) { objs = e.deployments.filter(d => d.namespace === ns); prefix = 'deployment.apps'; }
      else if (isSvc) { objs = e.services.filter(s => s.namespace === ns); prefix = 'service'; }
      else if (isNode) { objs = e.nodes.slice(); prefix = 'node'; }
      else { objs = e.namespaces.map(n => ({ name: n })); prefix = 'namespace'; }

      if (name) {
        // get <kind> <name>：单个资源（前缀匹配）
        const one = objs.find(o => o.name === name) || objs.find(o => o.name.startsWith(name));
        if (!one) { print(`Error from server (NotFound): ${kind} "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
        objs = [one];
      } else if (sel) {
        objs = objs.filter(o => matchSelector(o, sel));
      }

      if (fmt === 'yaml' || fmt === 'json') {
        let text;
        if (name) text = fmt === 'json' ? JSON.stringify(objs[0], null, 2) : toYaml(objs[0]);
        else if (fmt === 'json') text = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objs }, null, 2);
        else text = objs.map(o => toYaml(o)).join('\n---\n');
        text.split('\n').forEach(l => out.push(l));
      } else if (fmt === 'name') {
        for (const o of objs) out.push(`${prefix}/${o.name}`);
      } else if (isPod) {
        if (!objs.length) out.push('No resources found in ' + ns + ' namespace.');
        else {
          out.push(pad('NAME', 26) + pad('READY', 7) + pad('STATUS', 20) + pad('RESTARTS', 9) + (wide ? pad('IP', 17) : '') + 'NODE');
          for (const p of objs)
            out.push(pad(p.name, 26) + pad(p.ready, 7) + pad(p.status, 20) + pad(String(p.restarts), 9) + (wide ? pad(p.ip || '-', 17) : '') + p.node);
        }
      } else if (isDep) {
        out.push(pad('NAME', 14) + pad('READY', 9) + pad('UP-TO-DATE', 11) + (wide ? pad('IMAGE', 20) + 'SELECTOR' : 'IMAGE'));
        for (const d of objs) {
          const ready = e.podsOfDeployment(d.name, d.namespace).filter(p => p.status === 'Running').length;
          out.push(pad(d.name, 14) + pad(`${ready}/${d.replicas}`, 9) + pad(String(d.replicas), 11) + (wide ? pad(d.image, 20) + selStr(d) : d.image));
        }
        if (!objs.length) out.push('No resources found in ' + ns + ' namespace.');
      } else if (isSvc) {
        out.push(pad('NAME', 14) + pad('TYPE', 11) + pad('CLUSTER-IP', 13) + (wide ? pad('PORT', 16) + 'SELECTOR' : 'PORT'));
        for (const s of objs)
          out.push(pad(s.name, 14) + pad(s.type, 11) + pad(s.clusterIp, 13) + (wide ? pad(`${s.port}:${s.targetPort}/TCP`, 16) + (s.selector || '') : `${s.port}:${s.targetPort}/TCP`));
        if (!objs.length) out.push('No resources found in ' + ns + ' namespace.');
      } else if (isNode) {
        out.push(pad('NAME', 10) + pad('STATUS', 9) + pad('ROLES', 16) + pad('CPU', 5) + (wide ? pad('MEMORY', 8) + 'VERSION' : 'MEMORY'));
        for (const n of objs)
          out.push(pad(n.name, 10) + pad(n.status, 9) + pad(n.roles, 16) + pad(n.cpu, 5) + (wide ? pad(n.mem, 8) + n.ver : n.mem));
      } else { // namespaces
        out.push(pad('NAME', 14) + 'STATUS');
        for (const n of objs) out.push(pad(n.name, 14) + 'Active');
      }
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
    // kubectl logs <pod> [--tail=N]
    let tail = 0;
    const ti = rest.findIndex(a => a.startsWith('--tail='));
    if (ti >= 0) { tail = parseInt(rest[ti].split('=')[1], 10) || 0; rest.splice(ti, 1); }
    const name = rest[0];
    if (!name) { print('error: 需要 pod 名，如 kubectl logs <pod>', 'err'); sfx('err-syntax'); after(false); return; }
    const p = e.findPod(name, ns);
    if (!p) { print(`Error from server (NotFound): pods "${name}" not found`, 'err'); sfx('err-syntax'); after(false); return; }
    const lines = tail > 0 ? p.logs.slice(-tail) : p.logs;
    lines.forEach(l => print(l, l.startsWith('ERROR') || l.startsWith('FATAL') ? 'err' : 'out'));
    e.lastOut = lines.join('\n');
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
    // kubectl delete pod|deployment|service <名> · kubectl delete pods|deployments --all · kubectl delete -f <文件.yaml>
    const all = rest.includes('--all');
    if (all) rest.splice(rest.indexOf('--all'), 1);
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
    const isPod = kind === 'pod' || kind === 'pods';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    const isSvc = kind === 'service' || kind === 'services' || kind === 'svc';
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
      print('error: --all 暂只支持 pods / deployments', 'err'); sfx('err-syntax'); after(false); return;
    }
    if (!name) { print('用法：kubectl delete pod|deployment <名>（或 --all / -f <文件.yaml>）', 'err'); sfx('err-syntax'); after(false); return; }
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
    // kubectl rollout status|restart deployment/<名>（也接受 deployment <名>）
    const action = (rest[0] || '').toLowerCase();
    const target = rest[1] || '';
    let kind, name;
    if (target.includes('/')) { [kind, name] = target.split('/'); }
    else { kind = target; name = rest[2] || ''; }
    kind = (kind || '').toLowerCase();
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if ((action !== 'status' && action !== 'restart') || !isDep || !name) {
      print('用法：kubectl rollout status|restart deployment/<名>', 'err'); sfx('err-syntax'); after(false); return;
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
    } else {
      // restart：销毁旧 Pod，控制器重建一批新的（名字/编号全新，数量不变）
      e.pods = e.pods.filter(p => !(p.namespace === ns && p.owner === d.name));
      e._reconcile(d);
      print(`deployment.apps/${d.name} restarted`, 'ok');
      sfx('net-connect'); after(true);
    }
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

  label(rest, e, ns) {
    // kubectl label pod|deployment <名> key=value [key2=value2 ...]
    const kind = (rest[0] || '').toLowerCase();
    const name = rest[1];
    const pairs = rest.slice(2).filter(a => !a.startsWith('-') && a.includes('='));
    const isPod = kind === 'pod' || kind === 'pods';
    const isDep = kind === 'deployment' || kind === 'deployments' || kind === 'deploy';
    if ((!isPod && !isDep) || !name || !pairs.length) {
      print('用法：kubectl label pod|deployment <名> key=value', 'err'); sfx('err-syntax'); after(false); return;
    }
    const obj = isPod ? e.findPod(name, ns) : e.findDeployment(name, ns);
    if (!obj) {
      print(`Error from server (NotFound): ${isPod ? 'pods' : 'deployments'} "${name}" not found`, 'err');
      sfx('err-syntax'); after(false); return;
    }
    obj.labels = obj.labels || {};
    Object.assign(obj.labels, parseLabels(pairs.join(',')));
    print(`${isPod ? 'pod' : 'deployment.apps'}/${obj.name} labeled`, 'ok');
    sfx('net-connect'); after(true);
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

/* ---- 辅助：哈希 / 标签选择器 / 简易 YAML 序列化 ---- */
function hashStr(s) { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

// -l 选择器：支持 key（存在性）与 key=value，逗号分隔需全部满足
function matchSelector(o, sel) {
  const labels = o.labels || {};
  return String(sel).split(',').every(kv => {
    if (!kv) return true;
    const i = kv.indexOf('=');
    return i < 0 ? labels[kv] !== undefined : labels[kv.slice(0, i)] === kv.slice(i + 1);
  });
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
