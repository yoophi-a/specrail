# Kubernetes Deployment Skeleton

This reference turns the production topology into a Kubernetes starting point for the SpecRail API, GitHub webhook, and Telegram adapter services. Treat it as a deployment skeleton: wire it into your image publishing, secret manager, TLS, identity-aware ingress, and cluster network policy before production use.

## Boundaries

- Keep `specrail-api` behind authenticated operator routes. It owns the data directory, repo-visible artifacts, execution workspaces, and hosted `/operator` UI.
- Expose `specrail-github` only at `GITHUB_WEBHOOK_PATH` through a public webhook ingress path. Do not put operator authentication in front of GitHub deliveries; the app validates GitHub signatures.
- Expose `specrail-telegram` only at `TELEGRAM_WEBHOOK_PATH` through the Telegram webhook URL you register.
- Use `GET /healthz` for Kubernetes liveness/readiness probes. It is only a local service health signal, not proof that webhook signatures, operator authentication, or provider credentials are correct.

## Namespace And Shared Config

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: specrail
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: specrail-config
  namespace: specrail
data:
  SPECRAIL_API_BASE_URL: "http://specrail-api:4000"
  SPECRAIL_OPERATOR_BASE_URL: "https://specrail.example.com"
  GITHUB_WEBHOOK_PATH: "/github/webhook"
  TELEGRAM_WEBHOOK_PATH: "/telegram/webhook"
```

Store secrets in your cluster secret manager or an external secret controller. The inline shape below is only the API contract:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: specrail-secrets
  namespace: specrail
type: Opaque
stringData:
  GITHUB_WEBHOOK_SECRET: replace-with-secret-manager-value
  GITHUB_TOKEN: replace-with-secret-manager-value
  TELEGRAM_BOT_TOKEN: replace-with-secret-manager-value
```

## Persistent Storage

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: specrail-api-state
  namespace: specrail
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: specrail-github-relay
  namespace: specrail
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 5Gi
```

Use a single GitHub webhook replica when `GITHUB_RELAY_QUEUE_DIR` is backed by a `ReadWriteOnce` volume. For independent hosts or multiple replicas, use the PostgreSQL relay queue backend described in [GitHub webhook production operations](./github-production-ops.md).

## API Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: specrail-api
  namespace: specrail
spec:
  replicas: 1
  selector:
    matchLabels:
      app: specrail-api
  template:
    metadata:
      labels:
        app: specrail-api
    spec:
      containers:
        - name: specrail-api
          image: ghcr.io/your-org/specrail-api:latest
          ports:
            - name: http
              containerPort: 4000
          env:
            - name: SPECRAIL_PORT
              value: "4000"
            - name: SPECRAIL_DATA_DIR
              value: /var/lib/specrail/state
            - name: SPECRAIL_REPO_ARTIFACT_DIR
              value: /var/lib/specrail/repo-visible
          volumeMounts:
            - name: api-state
              mountPath: /var/lib/specrail
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 30
            failureThreshold: 3
      volumes:
        - name: api-state
          persistentVolumeClaim:
            claimName: specrail-api-state
---
apiVersion: v1
kind: Service
metadata:
  name: specrail-api
  namespace: specrail
spec:
  selector:
    app: specrail-api
  ports:
    - name: http
      port: 4000
      targetPort: http
```

## GitHub Webhook Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: specrail-github
  namespace: specrail
spec:
  replicas: 1
  selector:
    matchLabels:
      app: specrail-github
  template:
    metadata:
      labels:
        app: specrail-github
    spec:
      containers:
        - name: specrail-github
          image: ghcr.io/your-org/specrail-github:latest
          ports:
            - name: http
              containerPort: 4200
          env:
            - name: GITHUB_APP_PORT
              value: "4200"
            - name: SPECRAIL_API_BASE_URL
              valueFrom:
                configMapKeyRef:
                  name: specrail-config
                  key: SPECRAIL_API_BASE_URL
            - name: GITHUB_WEBHOOK_PATH
              valueFrom:
                configMapKeyRef:
                  name: specrail-config
                  key: GITHUB_WEBHOOK_PATH
            - name: GITHUB_FOLLOW_TERMINAL_EVENTS
              value: "true"
            - name: GITHUB_RELAY_QUEUE_DIR
              value: /var/lib/specrail-github/relay-queue
          envFrom:
            - secretRef:
                name: specrail-secrets
          volumeMounts:
            - name: github-relay
              mountPath: /var/lib/specrail-github
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 30
            failureThreshold: 3
      volumes:
        - name: github-relay
          persistentVolumeClaim:
            claimName: specrail-github-relay
---
apiVersion: v1
kind: Service
metadata:
  name: specrail-github
  namespace: specrail
spec:
  selector:
    app: specrail-github
  ports:
    - name: http
      port: 4200
      targetPort: http
```

## Telegram Adapter Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: specrail-telegram
  namespace: specrail
spec:
  replicas: 1
  selector:
    matchLabels:
      app: specrail-telegram
  template:
    metadata:
      labels:
        app: specrail-telegram
    spec:
      containers:
        - name: specrail-telegram
          image: ghcr.io/your-org/specrail-telegram:latest
          ports:
            - name: http
              containerPort: 4300
          env:
            - name: TELEGRAM_APP_PORT
              value: "4300"
            - name: SPECRAIL_API_BASE_URL
              valueFrom:
                configMapKeyRef:
                  name: specrail-config
                  key: SPECRAIL_API_BASE_URL
            - name: TELEGRAM_WEBHOOK_PATH
              valueFrom:
                configMapKeyRef:
                  name: specrail-config
                  key: TELEGRAM_WEBHOOK_PATH
          envFrom:
            - secretRef:
                name: specrail-secrets
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 30
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: specrail-telegram
  namespace: specrail
spec:
  selector:
    app: specrail-telegram
  ports:
    - name: http
      port: 4300
      targetPort: http
```

## Ingress Shape

Ingress annotations and auth integration vary by controller. The important split is that operator/API routes require authentication, while webhook routes remain publicly reachable but constrained to their exact paths.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: specrail-operator
  namespace: specrail
  annotations:
    example.com/auth-required: "true"
spec:
  tls:
    - hosts: ["specrail.example.com"]
      secretName: specrail-tls
  rules:
    - host: specrail.example.com
      http:
        paths:
          - path: /operator
            pathType: Prefix
            backend:
              service:
                name: specrail-api
                port:
                  name: http
          - path: /runs
            pathType: Prefix
            backend:
              service:
                name: specrail-api
                port:
                  name: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: specrail-webhooks
  namespace: specrail
spec:
  tls:
    - hosts: ["specrail.example.com"]
      secretName: specrail-tls
  rules:
    - host: specrail.example.com
      http:
        paths:
          - path: /github/webhook
            pathType: Exact
            backend:
              service:
                name: specrail-github
                port:
                  name: http
          - path: /telegram/webhook
            pathType: Exact
            backend:
              service:
                name: specrail-telegram
                port:
                  name: http
```

Add the other authenticated API paths used by the hosted operator UI, terminal clients, or internal automation behind the same authentication layer. Disable proxy buffering for SSE routes such as `/runs/:runId/events/stream` according to your ingress controller.

## Network Policy Starting Point

Adjust labels for your ingress controller and operator namespaces. The policy below starts from a deny-by-default posture for inbound traffic to SpecRail pods, then allows only ingress-controller traffic to HTTP ports and internal SpecRail service-to-service calls.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: specrail-ingress
  namespace: specrail
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 4000
        - protocol: TCP
          port: 4200
        - protocol: TCP
          port: 4300
    - from:
        - podSelector:
            matchLabels:
              app: specrail-github
        - podSelector:
            matchLabels:
              app: specrail-telegram
      ports:
        - protocol: TCP
          port: 4000
```

Add egress controls only after confirming provider API access requirements for GitHub, Telegram, executor CLIs, and any external database or secret manager.

## Validation Checklist

1. Apply manifests to a non-production namespace first.
2. Confirm all pods become ready through `/healthz`.
3. Confirm persistent volumes are mounted and writable.
4. Confirm `/operator` and API routes require authentication.
5. Confirm `/github/webhook` rejects invalid signatures and accepts a GitHub test delivery.
6. Confirm `/telegram/webhook` is reachable from Telegram after registration.
7. Confirm logs do not include raw webhook bodies, provider tokens, execution transcripts, or secret values.
