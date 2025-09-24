const { K3sContainer } = require("@testcontainers/k3s");

// Private Image Konfiguration
const PRIVATE_IMAGE_REPO = "test-repo";
const PRIVATE_IMAGE_NAME = "test-app:latest";

describe("Simple K3s Container Test", () => {
  let container;

  beforeAll(async () => {
    container = await new K3sContainer("rancher/k3s:v1.31.2-k3s1").start();

    // Registry-Credentials aus Environment-Variablen
    const registryServer = process.env.REGISTRY_SERVER;
    const registryUsername = process.env.REGISTRY_USERNAME;
    const registryPassword = process.env.REGISTRY_PASSWORD;
    const registryEmail = process.env.REGISTRY_EMAIL;

    // Nur erstellen wenn alle Credentials vorhanden sind
    if (registryServer && registryUsername && registryPassword) {
      // Docker Registry Secret erstellen
      const createSecretCmd = [
        "kubectl",
        "create",
        "secret",
        "docker-registry",
        "regcred",
        `--docker-server=${registryServer}`,
        `--docker-username=${registryUsername}`,
        `--docker-password=${registryPassword}`,
        `--docker-email=${registryEmail || "test@example.com"}`,
        "-n",
        "default",
      ];

      const result = await container.exec(createSecretCmd);
      if (result.exitCode !== 0) {
        console.error("Failed to create registry secret:", result.stderr);
      } else {
        console.log("Registry secret created successfully");
      }
    } else {
      console.log(
        "Skipping registry secret creation - credentials not provided",
      );
    }
  }, 180000);

  afterAll(async () => {
    await container.stop();
  });

  test("should start K3s container", () => {
    expect(container).toBeDefined();
  });

  test("should get valid kubeconfig", () => {
    const kubeconfig = container.getKubeConfig();
    expect(kubeconfig).toContain("apiVersion: v1");
  });

  test("should execute kubectl command", async () => {
    const result = await container.exec(["kubectl", "get", "nodes"]);
    expect(result.exitCode).toBe(0);
  });

  test("should have registry secret created", async () => {
    // Nur testen wenn Credentials vorhanden sind
    if (
      process.env.REGISTRY_SERVER &&
      process.env.REGISTRY_USERNAME &&
      process.env.REGISTRY_PASSWORD
    ) {
      const result = await container.exec([
        "kubectl",
        "get",
        "secret",
        "regcred",
        "-n",
        "default",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("regcred");
    } else {
      console.log("Skipping registry secret test - credentials not provided");
    }
  });

  test("should pull and run private registry image", async () => {
    // Nur testen wenn Registry Credentials vorhanden sind
    const registryServer = process.env.REGISTRY_SERVER;

    if (
      registryServer &&
      process.env.REGISTRY_USERNAME &&
      process.env.REGISTRY_PASSWORD
    ) {
      // Private Image URL aus Registry Server und Konstanten zusammenbauen
      const privateImage = `${registryServer}/${PRIVATE_IMAGE_REPO}/${PRIVATE_IMAGE_NAME}`;
      // Deployment mit privatem Image erstellen
      const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: private-image-test
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: private-test
  template:
    metadata:
      labels:
        app: private-test
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: test-container
        image: ${privateImage}
        command: ["sleep", "3600"]
`;

      // YAML in Datei schreiben und anwenden
      const writeResult = await container.exec([
        "sh",
        "-c",
        `echo '${deploymentYaml}' > /tmp/deployment.yaml`,
      ]);
      expect(writeResult.exitCode).toBe(0);

      const applyResult = await container.exec([
        "kubectl",
        "apply",
        "-f",
        "/tmp/deployment.yaml",
      ]);
      expect(applyResult.exitCode).toBe(0);

      // Warten bis Pod läuft (max 60 Sekunden)
      let podReady = false;
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const podStatus = await container.exec([
          "kubectl",
          "get",
          "pods",
          "-l",
          "app=private-test",
          "-o",
          "jsonpath={.items[0].status.phase}",
        ]);

        if (podStatus.stdout.includes("Running")) {
          podReady = true;
          break;
        }
      }

      expect(podReady).toBe(true);

      // Cleanup
      await container.exec([
        "kubectl",
        "delete",
        "deployment",
        "private-image-test",
      ]);
    } else {
      console.log(
        "Skipping private image test - registry credentials not provided",
      );
    }
  });
});
