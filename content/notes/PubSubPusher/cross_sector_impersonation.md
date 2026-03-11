---
title: PubSub Pusher
---

## Q1

what is pubsub-pusher@${local.gcp_project_id}.iam.gserviceaccount.com used for. Is it being imperonsated by some service account for some cross sectore pubsub subscription if so where and how? Whats its use? Also which account or accounts token is sent to the proxy for cross sector pubsub commmunication?

### Answer

Based on my analysis of the codebase, here's what `pubsub-pusher@${local.gcp_project_id}.iam.gserviceaccount.com` is used for and how cross-sector pubsub communication works:

## Purpose of `pubsub-pusher@${local.gcp_project_id}.iam.gserviceaccount.com`

This is the **common service account** for the pubsub-grpc-pusher system. It has two primary uses:

1. **MSID Token Issuance**: It's used for issuing MSID (MicroService IDentification) tokens for peer authentication between services. pubsub-grpc-pusher:5-10 pubsub-grpc-pusher:9-15

2. **Access to Proto File Descriptor Sets**: It's granted `storage.objectViewer` role to access platform proto file descriptor sets stored in GCS buckets. microservices-terraform:43-77

## Cross-Sector Impersonation

Yes, impersonation is used for cross-sector pubsub subscriptions. There are different scenarios:

**For Push Spec (consuming messages):**

- If `CrossSector.OidcToken.ServiceAccountEmail` is explicitly specified, that account is impersonated
- If not specified, the default service account is used (no impersonation) pubsub-grpc-pusher:283-295
- the namespace dedicated service account impersonates the above SA created on the subscriber side. This subscriber side SA has to be added to IDP so that the Google ID Token created can be verified

**For Publish Spec (publishing messages):**

- A namespace-dedicated service account is used: `pub-{trimmed-namespace}@{project}.iam.gserviceaccount.com` pubsub-grpc-pusher:323-330 pubsub-grpc-pusher:73-82 again impersonates the subscriber created SA.

## Which Account's Token is Sent to the Proxy

For cross-sector communication, a **Google ID Token** is generated and sent to the escape proxy/gateway. The token source depends on the configuration:

1. **If impersonation is configured**: The token is generated via IAM Credentials API using the impersonated service account pubsub-grpc-pusher:18-26 pubsub-grpc-pusher:72-96

2. **If no impersonation**: The default service account's token is used pubsub-grpc-pusher:55-62

The token is then attached to the gRPC request via an interceptor: pubsub-grpc-pusher:253-274

## Notes

- The token is used for authentication with the gateway endpoint specified in `EscapeProxy.GatewayEndpoint`
- The escape proxy interceptor adds the gateway endpoint to the context so the request is routed through the cross-sector gateway pubsub-grpc-pusher:11-17
- The system also converts SUID (Sector User ID) to PPID (Platform-Private ID) for the destination client ID as part of cross-sector communication
- Multiple namespace-dedicated service accounts are created in the pubsub-pusher GCP project, one for each namespace that needs cross-sector publishing capabilities microservices-terraform:1-46

### Citations

**File:** authority/service_account.go (L5-10)

```go
const commonServiceAccountFormat = "pubsub-pusher@%s.iam.gserviceaccount.com"

// CommonServiceAccount returns the common Google Service Account.
// It is used for issuing MSID token basically.
func CommonServiceAccount(project string) string {
	return fmt.Sprintf(commonServiceAccountFormat, project)
```

**File:** authority/msid.go (L9-15)

```go
func NewMSIDTokenIssuer(ctx context.Context, project string) (msid.TokenIssuer, func(), error) {
	issuer, closer, err := msid.NewTokenIssuer(ctx, nil, msid.WithImpersonation(CommonServiceAccount(project)))
	if err != nil {
		return nil, nil, err
	}

	return issuer, closer, nil
```

**File:** terraform/microservices/kouzoh-platform-proto-jp/production/google_storage_bucket_iam_member.tf (L43-77)

```terraform
resource "google_storage_bucket_iam_member" "kouzoh_pubsub_pusher_common_dev_is_platform_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.platform_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@kouzoh-pubsub-pusher-jp-dev.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "kouzoh_pubsub_pusher_common_prod_is_platform_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.platform_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@kouzoh-pubsub-pusher-jp-prod.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "mercoin_pubsub_pusher_common_dev_is_platform_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.platform_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@mercoin-pubsub-pusher-jp-dev.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "mercoin_pubsub_pusher_common_prod_is_platform_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.platform_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@mercoin-pubsub-pusher-jp-prod.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "kouzoh_pubsub_pusher_common_dev_is_gop_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.gop_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@kouzoh-pubsub-pusher-jp-dev.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "kouzoh_pubsub_pusher_common_prod_is_gop_proto_file_descriptor_sets_storage_object_viewer" {
  bucket = google_storage_bucket.gop_proto_file_descriptor_sets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:pubsub-pusher@kouzoh-pubsub-pusher-jp-prod.iam.gserviceaccount.com"
}
```

**File:** controllers/pubsubgrpcpush_controller.go (L283-295)

```go
	var crossSector *pushercfg.PushTaskCrossSector
	if item.Spec.Push.CrossSector != nil && item.Spec.Push.EscapeProxy != nil {
		var impersonateSA string
		if item.Spec.Push.CrossSector.OidcToken != nil {
			impersonateSA = item.Spec.Push.CrossSector.OidcToken.ServiceAccountEmail
		}

		crossSector = &pushercfg.PushTaskCrossSector{
			GatewayEndpoint:           item.Spec.Push.EscapeProxy.GatewayEndpoint,
			DestinationClientID:       item.Spec.Push.CrossSector.DestinationClientID,
			ImpersonateServiceAccount: impersonateSA,
		}
	}
```

**File:** controllers/pubsubgrpcpush_controller.go (L323-330)

```go
	var crossSector *pushercfg.PushTaskCrossSector
	if item.Spec.Publish.CrossSector != nil && item.Spec.Publish.EscapeProxy != nil {
		crossSector = &pushercfg.PushTaskCrossSector{
			GatewayEndpoint:           item.Spec.Publish.EscapeProxy.GatewayEndpoint,
			DestinationClientID:       item.Spec.Publish.CrossSector.DestinationClientID,
			ImpersonateServiceAccount: namespaceDedicatedServiceAccount(item.Namespace, r.Namespace),
		}
	}
```

**File:** controllers/resources.go (L73-82)

```go
// namespaceDedicatedServiceAccount returns the Google Service Account name for the target namespace.
// The service account must be created in the same GCP project name with the controller's namespace name.
//
// Google Service Account ID can be 30 letters at max. Namespace name is normally same to Service ID with Env.
// Service ID with Env can 30 letters at max. To add ns- prefix for dedicated service account ID, namespace
// name must be shortened. A namespace name typically contains short env name as suffix, so it is omitted.
func namespaceDedicatedServiceAccount(targetNamespace, namespace string) string {
	trimedTargetNS := trimShortEnvSuffix(targetNamespace)
	return fmt.Sprintf("ns-%s@%s.iam.gserviceaccount.com", trimedTargetNS, namespace)
}
```

**File:** authority/impersonate.go (L18-26)

```go
// NewGoogleIDTokenSource returns TokenSource that creates Google ID Token.
// If impersonateEmail is not empty, the GIDT is created by the email with impersonation.
func NewGoogleIDTokenSource(ctx context.Context, audience string, impersonateEmail string) (oauth2.TokenSource, error) {
	if impersonateEmail == "" {
		return newDefaultIDTokenSource(ctx, audience)
	}

	return newImpersonateIDTokenSource(ctx, audience, impersonateEmail)
}
```

**File:** authority/impersonate.go (L55-62)

```go
func newDefaultIDTokenSource(ctx context.Context, audience string) (oauth2.TokenSource, error) {
	ts, err := googleauth.DefaultTokenSourceWithProactiveCacheForIDToken(ctx, audience)
	if err != nil {
		return nil, fmt.Errorf("failed to create default token source: %w", err)
	}

	return ts, nil
}
```

**File:** authority/impersonate.go (L72-96)

```go
func newImpersonateIDTokenSource(ctx context.Context, audience string, email string) (oauth2.TokenSource, error) {
	cli, err := newIamCredentialsClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to create IAM Credentials client: %w", err)
	}

	issue := func() (*oauth2.Token, error) {
		res, err := cli.GenerateIdToken(ctx, &credentialspb.GenerateIdTokenRequest{
			Name:         fmt.Sprintf("projects/-/serviceAccounts/%s", email),
			Audience:     audience,
			IncludeEmail: true, // required for authority-token
		})
		if err != nil {
			return nil, fmt.Errorf("failed to generate id token: %w", err)
		}

		return &oauth2.Token{
			AccessToken: res.Token,
			TokenType:   "bearer",
			// The token is valid for one hour, leave a little buffer
			Expiry: time.Now().Add(55 * time.Minute), //nolint:mnd
		}, nil
	}

	return newTokenSource(issue), nil
```

**File:** pusher/pusher.go (L253-274)

```go
	if cfg.CrossSectorRequest.Enable {
		// For cross-sector request
		csr := cfg.CrossSectorRequest

		var ts oauth2.TokenSource
		ts, err := authority.NewGoogleIDTokenSource(context.Background(), csr.GatewayEndpoint, csr.ImpersonateServiceAccount)
		if err != nil {
			return nil, NewPusherResourceError(cfg.Name, "unexpected error", err.Error())
		}

		suidConverter := sectoruserid.NewProtoMessageConverter(
			cfg.SUIDClient,
			sectoruserid.WithProtoResolver(dynamicpb.NewTypes(registry)),
		)
		interceptors = append(interceptors,
			// Add an interceptor to attach Google ID Token as authorization metadata.
			authority.TokenSourceUnaryClientInterceptor(ts),
			// Add an interceptor to convert SUID to PPID for the destination client ID.
			sectoruseridgrpc.CallerUnaryClientInterceptor(suidConverter, sectoruseridgrpc.WithClientID(csr.DestinationClientID)),
			// Add an interceptor to specify gateway's endpoint to request via escape proxy.
			middlewares.EscapeProxyInterceptor(csr.GatewayEndpoint),
		)
```

**File:** pusher/middlewares/escapeproxy.go (L11-17)

```go
// EscapeProxyInterceptor returns an UnaryClientInterceptor that creates a context for escape proxy.
func EscapeProxyInterceptor(endpoint string) grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply interface{}, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		ctx = escapeproxy.WithContext(ctx, endpoint)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
```

**File:** terraform/microservices/kouzoh-pubsub-pusher-jp/development/module_namespace_dedicated_service_account.tf (L1-46)

```terraform
# For kouzoh-pubsub-pusher-jp-dev namespace
module "ns_kouzoh_pubsub_pusher_jp_dev" {
  source = "../modules/namespace_dedicated_service_account"

  env          = "dev"
  organization = "MERPAY"
  service_id   = "kouzoh-pubsub-pusher-jp"
  namespace    = "kouzoh-pubsub-pusher-jp-dev"

  providers = {
    google = google
    idp    = idp
  }
}

# For kouzoh-bigbrother-jp-dev namespace
module "ns_kouzoh_bigbrother_jp_dev" {
  source = "../modules/namespace_dedicated_service_account"

  env          = "dev"
  organization = "MERPAY"
  service_id   = "kouzoh-bigbrother-jp"
  namespace    = "kouzoh-bigbrother-jp-dev"

  providers = {
    google = google
    idp    = idp
  }
}

# For kouzoh-user-account-jp-dev namespace
module "ns_kouzoh_user_account_jp_dev" {
  source = "../modules/namespace_dedicated_service_account"

  env          = "dev"
  organization = "MERPAY"
  service_id   = "kouzoh-user-account-jp"
  namespace    = "kouzoh-user-account-jp-dev"

  destination_client_ids = ["__"]

  providers = {
    google = google
    idp    = idp
  }
}
```
