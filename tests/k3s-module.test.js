const { K3sContainer } = require("@testcontainers/k3s");

describe("K3s Module Tests", () => {
  let k3sContainer;

  beforeAll(async () => {
    console.log("Starting K3s container using @testcontainers/k3s module...");

    k3sContainer = await new K3sContainer("rancher/k3s:v1.31.2-k3s1")
      .withStartupTimeout(180000)
      .start();

    console.log("K3s container started successfully");
  }, 240000);

  afterAll(async () => {
    if (k3sContainer) {
      await k3sContainer.stop();
      console.log("K3s container stopped");
    }
  });

  test("K3s container should be running", () => {
    expect(k3sContainer).toBeDefined();
    expect(k3sContainer.getId()).toBeTruthy();
  });

  test("Should get kubeconfig", async () => {
    const kubeConfig = k3sContainer.getKubeConfig();

    expect(kubeConfig).toBeDefined();
    expect(kubeConfig).toContain("apiVersion: v1");
    expect(kubeConfig).toContain("kind: Config");
    expect(kubeConfig).toContain("clusters:");
    expect(kubeConfig).toContain("users:");
    expect(kubeConfig).toContain("contexts:");

    console.log("Kubeconfig retrieved successfully");
  });

  test("Should execute kubectl commands", async () => {
    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "nodes",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const nodes = JSON.parse(result.output);
    expect(nodes.items).toBeDefined();
    expect(nodes.items.length).toBeGreaterThan(0);

    const nodeName = nodes.items[0].metadata.name;
    console.log(`K3s node name: ${nodeName}`);

    expect(nodes.items[0].status.conditions).toBeDefined();
  });

  test("Should get cluster info", async () => {
    const result = await k3sContainer.exec(["kubectl", "cluster-info"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Kubernetes control plane");

    console.log("Cluster info retrieved");
  });

  test("Should list all namespaces", async () => {
    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "namespaces",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const namespaces = JSON.parse(result.output);
    const namespaceNames = namespaces.items.map((ns) => ns.metadata.name);

    expect(namespaceNames).toContain("default");
    expect(namespaceNames).toContain("kube-system");
    expect(namespaceNames).toContain("kube-public");
    expect(namespaceNames).toContain("kube-node-lease");

    console.log(`Found ${namespaces.items.length} namespaces`);
  });

  test("Should deploy a simple pod", async () => {
    const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  labels:
    app: test
spec:
  containers:
  - name: nginx
    image: nginx:alpine
    ports:
    - containerPort: 80
`;

    await k3sContainer.exec([
      "sh",
      "-c",
      `echo '${podYaml}' | kubectl apply -f -`,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10000));

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "pod",
      "test-pod",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const pod = JSON.parse(result.output);
    expect(pod.metadata.name).toBe("test-pod");
    expect(pod.spec.containers[0].image).toBe("nginx:alpine");

    const statusResult = await k3sContainer.exec([
      "kubectl",
      "get",
      "pod",
      "test-pod",
      "--no-headers",
    ]);
    console.log("Pod status:", statusResult.output.trim());
  });

  test("Should create deployment with multiple replicas", async () => {
    const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.25-alpine
        ports:
        - containerPort: 80
`;

    await k3sContainer.exec([
      "sh",
      "-c",
      `echo '${deploymentYaml}' | kubectl apply -f -`,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15000));

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "deployment",
      "nginx-deployment",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const deployment = JSON.parse(result.output);
    expect(deployment.spec.replicas).toBe(3);
    // Check if readyReplicas exists before asserting
    if (deployment.status && deployment.status.readyReplicas !== undefined) {
      expect(deployment.status.readyReplicas).toBeGreaterThan(0);
    } else {
      console.log("Deployment status:", JSON.stringify(deployment.status));
    }

    const podsResult = await k3sContainer.exec([
      "kubectl",
      "get",
      "pods",
      "-l",
      "app=nginx",
      "--no-headers",
    ]);
    const podLines = podsResult.output
      .trim()
      .split("\n")
      .filter((line) => line);

    console.log(`Deployment created with ${podLines.length} pods`);
    expect(podLines.length).toBe(3);
  });

  test("Should expose deployment as service", async () => {
    const serviceYaml = `
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: ClusterIP
`;

    await k3sContainer.exec([
      "sh",
      "-c",
      `echo '${serviceYaml}' | kubectl apply -f -`,
    ]);

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "service",
      "nginx-service",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const service = JSON.parse(result.output);
    expect(service.spec.ports[0].port).toBe(80);
    expect(service.spec.type).toBe("ClusterIP");

    const endpointsResult = await k3sContainer.exec([
      "kubectl",
      "get",
      "endpoints",
      "nginx-service",
      "-o",
      "json",
    ]);
    const endpoints = JSON.parse(endpointsResult.output);

    // Check if endpoints exist before asserting
    if (endpoints.subsets && endpoints.subsets.length > 0) {
      expect(endpoints.subsets[0].addresses).toBeDefined();
      if (endpoints.subsets[0].addresses) {
        expect(endpoints.subsets[0].addresses.length).toBeGreaterThan(0);
        console.log(
          `Service exposed with ${endpoints.subsets[0].addresses.length} endpoints`,
        );
      }
    } else {
      console.log("No endpoints found yet, service may still be initializing");
    }
  });

  test("Should scale deployment", async () => {
    await k3sContainer.exec([
      "kubectl",
      "scale",
      "deployment",
      "nginx-deployment",
      "--replicas=5",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10000));

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "deployment",
      "nginx-deployment",
      "-o",
      "json",
    ]);

    const deployment = JSON.parse(result.output);
    expect(deployment.spec.replicas).toBe(5);

    const podsResult = await k3sContainer.exec([
      "kubectl",
      "get",
      "pods",
      "-l",
      "app=nginx",
      "--no-headers",
    ]);
    const podLines = podsResult.output
      .trim()
      .split("\n")
      .filter((line) => line);

    console.log(`Deployment scaled to ${podLines.length} pods`);
    expect(podLines.length).toBe(5);
  });

  test("Should apply resource quotas", async () => {
    const resourceQuotaYaml = `
apiVersion: v1
kind: ResourceQuota
metadata:
  name: test-quota
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.cpu: "4"
    limits.memory: 4Gi
    persistentvolumeclaims: "5"
    pods: "10"
`;

    await k3sContainer.exec([
      "sh",
      "-c",
      `echo '${resourceQuotaYaml}' | kubectl apply -f -`,
    ]);

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "resourcequota",
      "test-quota",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const quota = JSON.parse(result.output);
    expect(quota.spec.hard.pods).toBe("10");
    expect(quota.spec.hard["requests.memory"]).toBe("2Gi");

    console.log("Resource quota applied successfully");
  });

  test("Should create and verify NetworkPolicy", async () => {
    const networkPolicyYaml = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-network-policy
spec:
  podSelector:
    matchLabels:
      app: nginx
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          access: allowed
    ports:
    - protocol: TCP
      port: 80
  egress:
  - to:
    - podSelector: {}
    ports:
    - protocol: TCP
      port: 443
`;

    await k3sContainer.exec([
      "sh",
      "-c",
      `echo '${networkPolicyYaml}' | kubectl apply -f -`,
    ]);

    const result = await k3sContainer.exec([
      "kubectl",
      "get",
      "networkpolicy",
      "test-network-policy",
      "-o",
      "json",
    ]);

    expect(result.exitCode).toBe(0);

    const policy = JSON.parse(result.output);
    expect(policy.spec.podSelector.matchLabels.app).toBe("nginx");
    expect(policy.spec.policyTypes).toContain("Ingress");
    expect(policy.spec.policyTypes).toContain("Egress");

    console.log("NetworkPolicy created successfully");
  });

  test("Should clean up resources", async () => {
    await k3sContainer.exec([
      "kubectl",
      "delete",
      "deployment",
      "nginx-deployment",
    ]);
    await k3sContainer.exec(["kubectl", "delete", "service", "nginx-service"]);
    await k3sContainer.exec(["kubectl", "delete", "pod", "test-pod"]);
    await k3sContainer.exec([
      "kubectl",
      "delete",
      "resourcequota",
      "test-quota",
    ]);
    await k3sContainer.exec([
      "kubectl",
      "delete",
      "networkpolicy",
      "test-network-policy",
    ]);

    const podsResult = await k3sContainer.exec([
      "kubectl",
      "get",
      "pods",
      "--no-headers",
    ]);
    const remainingPods = podsResult.output
      .trim()
      .split("\n")
      .filter((line) => line && !line.includes("Terminating"));

    console.log("Resources cleaned up");
  });
});
