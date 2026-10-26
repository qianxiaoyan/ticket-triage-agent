# API and Integrations

## Rate limits

Default limits are 600 requests per minute per workspace and 60 requests per minute per API key. When a limit is exceeded the API returns HTTP 429 with a Retry-After header. Limits are per minute windows, not sliding; a burst after the window resets is expected.

## API keys and rotation

Keys are shown once at creation. Rotate keys by creating a new key, deploying it, then revoking the old one; revoking first will break production traffic. Key scope can be restricted to read-only. A leaked key must be revoked immediately and the workspace owner notified.

## Common error codes

- 401 invalid or revoked key
- 403 key scope does not allow the endpoint
- 409 conflict, usually a duplicate idempotency key
- 422 validation error, the response body names the failing field
- 429 rate limited, honor Retry-After
- 5xx server-side, safe to retry with exponential backoff

## Webhooks

Webhooks retry for 24 hours with exponential backoff. Deliveries are signed; verify the signature header before trusting the payload. Endpoints must respond within 5 seconds or the delivery is marked failed. Duplicate deliveries are possible, so handlers must be idempotent.

## Sandbox environment

The sandbox is separate from production and resets weekly. Sandbox keys never work against production and vice versa. Sandbox does not send real emails or charge real cards.

## Data residency

EU data residency is available on Enterprise. Choosing the EU region pins storage and processing to Frankfurt. Migration between regions requires a support-assisted project and is not self-service.
