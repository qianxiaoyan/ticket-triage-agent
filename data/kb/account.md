# Account and Access

## Password reset and locked accounts

Password reset links expire after 30 minutes. Accounts lock for 30 minutes after 6 failed attempts. Support cannot bypass a lock; the customer must wait or use SSO.

## Two-factor authentication

TOTP is available on all tiers. SMS 2FA is deprecated and disabled for new workspaces. Lost recovery codes require identity verification: a workspace owner must confirm the request from an existing verified email on the same domain.

## Single sign-on

SAML and OIDC SSO are Enterprise-only. Setup requires a metadata file or a discovery endpoint plus an attribute mapping for email, first name, and last name. Just-in-time provisioning is enabled by default; SCIM provisioning is a separate add-on.

## Member management and ownership transfer

Only owners can transfer ownership. Transfer requires the target user to accept within 7 days and to have 2FA enabled. Deleting a workspace requires typing the workspace name and is irreversible after 30 days.

## Data export and deletion

Customers can export all workspace data as JSON or CSV from settings. A full export of a large workspace may take up to 48 hours and is delivered as a download link valid for 7 days. Account deletion removes production data within 30 days; encrypted backups expire within 90 days.

## Suspicious login or account takeover

If a customer reports an unauthorized login, suspend the affected sessions, force a password reset, and check audit logs for the source IP and the actions taken. Do not delete the workspace. Account takeover reports are P1 regardless of customer tier.
