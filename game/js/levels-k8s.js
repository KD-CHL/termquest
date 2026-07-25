// Kubernetes 模块关卡 —— 集群查看 / Deployment / 扩缩容 / Service / apply / 排障
// setup/check 操作 K8sEngine（e）。
export const K8S_LEVELS = [
  /* ============ 01 认识集群 ============ */
  {
    stage: '01 认识集群', id: 'K01', title: '集群初探', par: 3,
    desc: '欢迎登上 Kubernetes 集群！用 <code>kubectl get nodes</code> 看看有几台节点，<code>kubectl get pods</code> 看看正在运行的 Pod，再 <code>kubectl get ns</code> 看看命名空间。',
    hints: ['kubectl get nodes', 'kubectl get pods', 'kubectl get ns'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('kubectl') && e.lastOut.includes('default'); },
    done: 'kubectl get 是探索集群的万能钥匙：nodes 看算力、pods 看负载、ns 看隔离空间。'
  },

  /* ============ 02 部署应用 ============ */
  {
    stage: '02 部署应用', id: 'K02', title: '创建第一个 Deployment', par: 2,
    desc: '用 <code>kubectl create deployment web --image=nginx --replicas=3</code> 部署 3 副本的 nginx，再 <code>kubectl get pods</code> 确认它们都跑起来了。',
    hints: ['kubectl create deployment web --image=nginx --replicas=3', 'kubectl get pods'],
    setup(e) { e.reset(); },
    check(e) {
      const d = e.findDeployment('web');
      return !!d && d.replicas === 3 && e.podsOfDeployment('web').length === 3;
    },
    done: 'Deployment 声明"我要 N 个副本"，控制器自动创建并维持 Pod 数量——这就是 K8s 的声明式思想。'
  },
  {
    stage: '02 部署应用', id: 'K03', title: '深入 Pod 内部', par: 3,
    desc: 'frontend 应用已经在跑了。用 <code>kubectl get pods</code> 找到它的 Pod 名，<code>kubectl describe pod <名></code> 看详情，<code>kubectl logs <名></code> 看日志。',
    hints: ['kubectl get pods', 'kubectl describe pod <pod名>', 'kubectl logs <pod名>'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('kubectl') && e.lastOut.includes('INFO'); },
    done: 'describe 看元数据与事件，logs 看容器输出——排查 Pod 问题的左膀右臂。'
  },

  /* ============ 03 弹性伸缩 ============ */
  {
    stage: '03 弹性伸缩', id: 'K04', title: '流量来了，扩容！', par: 2,
    desc: '大促流量将至，web 应用需要从 2 副本扩到 5 副本：<code>kubectl scale deployment web --replicas=5</code>，然后 <code>kubectl get pods</code> 验证。',
    hints: ['kubectl scale deployment web --replicas=5', 'kubectl get pods'],
    setup(e) { e.reset(); e.createDeployment('web', 'nginx', 2, 'default'); },
    check(e) {
      const d = e.findDeployment('web');
      return !!d && d.replicas === 5 && e.podsOfDeployment('web').length === 5;
    },
    done: 'scale 一条命令改副本数，控制器立刻补齐 Pod——K8s 弹性伸缩的最小演示。'
  },

  /* ============ 04 暴露服务 ============ */
  {
    stage: '04 暴露服务', id: 'K05', title: '让外部访问进来', par: 2,
    desc: 'frontend 只能在集群内部访问。用 <code>kubectl expose deployment frontend --port=80 --type=NodePort</code> 把它暴露出去，再 <code>kubectl get services</code> 查看分配的 ClusterIP。',
    hints: ['kubectl expose deployment frontend --port=80 --type=NodePort', 'kubectl get services'],
    setup(e) { e.reset(); },
    check(e) {
      const s = e.findService('frontend');
      return !!s && s.type === 'NodePort' && s.port === 80;
    },
    done: 'Service 是 Pod 的稳定入口：ClusterIP 集群内访问，NodePort 对外暴露。Pod 会漂移，Service 永不失联。'
  },

  /* ============ 05 声明式配置 ============ */
  {
    stage: '05 声明式配置', id: 'K06', title: '用 YAML 部署', par: 5,
    desc: '生产环境都用 YAML 声明资源。写一个 manifest：<code>echo "kind: Deployment" > app.yaml</code>，依次追加 <code>name: api</code>、<code>image: node:18</code>、<code>replicas: 2</code>，然后 <code>kubectl apply -f app.yaml</code>。',
    hints: ['echo "kind: Deployment" > app.yaml', 'echo "name: api" >> app.yaml', 'echo "image: node:18" >> app.yaml', 'echo "replicas: 2" >> app.yaml', 'kubectl apply -f app.yaml'],
    setup(e) { e.reset(); },
    check(e) {
      const d = e.findDeployment('api');
      return !!d && d.replicas === 2 && e.podsOfDeployment('api').length === 2;
    },
    done: 'apply -f 把 YAML 变成集群状态，可版本化、可复现——GitOps 的基石就是这一行命令。'
  },

  /* ============ 06 故障排查 ============ */
  {
    stage: '06 故障排查', id: 'K07', title: '拯救 CrashLoopBackOff', par: 3,
    desc: 'worker 应用的 Pod 一直在崩溃重启（CrashLoopBackOff）。先 <code>kubectl logs <pod名></code> 看它为什么挂，然后 <code>kubectl delete pod <pod名></code> 让控制器重建一个健康的副本。',
    hints: ['kubectl get pods', 'kubectl logs <pod名>', 'kubectl delete pod <pod名>'],
    setup(e) {
      e.reset();
      e.createDeployment('worker', 'busybox', 1, 'default');
      const p = e.podsOfDeployment('worker')[0];
      p.status = 'CrashLoopBackOff'; p.ready = '0/1'; p.restarts = 5;
      p.logs = ['INFO starting...', 'ERROR config not found', 'FATAL exit code 1'];
    },
    check(e) {
      const pods = e.podsOfDeployment('worker');
      return e.used.has('kubectl') && pods.length === 1 && pods.every(p => p.status === 'Running');
    },
    done: '看日志定位原因，删 Pod 触发重建——Deployment 的自愈能力让"重启治百病"成为 K8s 的一等公民。'
  },

  /* ============ 07 综合实战 ============ */
  {
    stage: '07 综合实战', id: 'K08', title: '上线一个完整服务', par: 4,
    desc: '综合挑战：① <code>kubectl create deployment shop --image=redis --replicas=2</code> 部署；② <code>kubectl scale deployment shop --replicas=4</code> 扩容；③ <code>kubectl expose deployment shop --port=6379</code> 暴露；④ <code>kubectl get all</code> 总览全局。',
    hints: ['kubectl create deployment shop --image=redis --replicas=2', 'kubectl scale deployment shop --replicas=4', 'kubectl expose deployment shop --port=6379', 'kubectl get all'],
    setup(e) { e.reset(); },
    check(e) {
      const d = e.findDeployment('shop');
      const s = e.findService('shop');
      return !!d && d.replicas === 4 && e.podsOfDeployment('shop').length === 4 && !!s;
    },
    done: '部署 → 扩容 → 暴露 → 总览——一套完整的 K8s 上线流程。恭喜，Kubernetes 模块通关！🎓'
  },

  /* ============ 08 高级运维 ============ */
  {
    stage: '08 高级运维', id: 'K09', title: 'run 一个 Pod 应急', par: 3,
    desc: 'kubectl run 是创建临时 Pod 最快的方式：<code>kubectl run debug --image=busybox</code>，然后 <code>kubectl get pods</code> 确认它 Running，再用 <code>kubectl get pod debug -o wide</code> 看看它被调度到哪台节点、分到了什么 Pod IP。',
    hints: ['kubectl run debug --image=busybox', 'kubectl get pods', 'kubectl get pod debug -o wide'],
    setup(e) { e.reset(); },
    check(e) {
      const p = e.pods.find(x => x.name === 'debug' && x.namespace === 'default');
      return !!p && p.image === 'busybox' && p.status === 'Running' && e.lastOut.includes('debug') && e.lastOut.includes('10.244.');
    },
    done: 'run 一条命令拉起 Pod，-o wide 暴露 IP 与节点——应急调试的标准开场。'
  },
  {
    stage: '08 高级运维', id: 'K10', title: '用标签定位 Pod', par: 3,
    desc: '标签是资源的身份贴纸。先给 frontend 的某个 Pod 打上标记：<code>kubectl label pod <pod名> env=canary</code>，再用 <code>kubectl get pods -l env=canary</code> 把它精确筛选出来。',
    hints: ['kubectl get pods', 'kubectl label pod <pod名> env=canary', 'kubectl get pods -l env=canary'],
    setup(e) { e.reset(); },
    check(e) {
      const tagged = e.pods.filter(p => p.namespace === 'default' && p.labels && p.labels.env === 'canary');
      return tagged.length >= 1 && e.used.has('kubectl') && e.lastOut.includes(tagged[0].name);
    },
    done: 'key=value 标签 + -l 选择器，成百上千的 Pod 也能任你切片——这是灰度发布与批量运维的起点。'
  },
  {
    stage: '08 高级运维', id: 'K11', title: '滚动重启', par: 3,
    desc: '发布新版本后需要重启 Pod 才能生效。用 <code>kubectl rollout restart deployment frontend</code> 滚动重启 frontend（旧 Pod 会被整批换掉），再 <code>kubectl rollout status deployment/frontend</code> 确认滚动完成。',
    hints: ['kubectl rollout restart deployment frontend', 'kubectl get pods', 'kubectl rollout status deployment/frontend'],
    setup(e) { e.reset(); e._k11Before = e.podsOfDeployment('frontend').map(p => p.name); },
    check(e) {
      const pods = e.podsOfDeployment('frontend');
      return pods.length === 2 && pods.every(p => p.status === 'Running' && !e._k11Before.includes(p.name))
        && e.lastOut.includes('successfully rolled out');
    },
    done: 'rollout restart 让 Pod 逐个重建、服务不掉线——云原生时代"重启治百病"的标准姿势。'
  },
  {
    stage: '08 高级运维', id: 'K12', title: '清空一个命名空间', par: 4,
    desc: 'tmp 命名空间里堆满了调试用的测试资源：先 <code>kubectl top pods -n tmp</code> 看看它们的资源占用，然后 <code>kubectl delete deployments --all -n tmp</code> 清掉全部 Deployment，最后 <code>kubectl delete pods --all -n tmp</code> 清掉落单的 Pod。',
    hints: ['kubectl top pods -n tmp', 'kubectl delete deployments --all -n tmp', 'kubectl delete pods --all -n tmp', 'kubectl get pods -n tmp'],
    setup(e) {
      e.reset();
      e.namespaces.push('tmp');
      e.createDeployment('test1', 'nginx', 2, 'tmp');
      e.createDeployment('test2', 'redis', 1, 'tmp');
      e.createPod(null, 'busybox', 'tmp', 'Running', { app: 'scratch' }, 'scratch');
    },
    check(e) {
      return e.used.has('kubectl')
        && e.deployments.every(d => d.namespace !== 'tmp')
        && e.pods.every(p => p.namespace !== 'tmp');
    },
    done: 'top 看占用、--all 批量清空——干净的命名空间，从一次彻底的大扫除开始。'
  },
];
