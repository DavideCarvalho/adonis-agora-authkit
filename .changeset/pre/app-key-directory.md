---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-client': minor
---

App key directory, so Agora apps share public keys without copying them. authkit-server: `PUT /api/apps/keys` (`{ keys: [{ purpose, jwk }] }`, an app publishes its own public OKP keys with its service client id and secret; a key with `d`, an invalid `purpose` or too many keys get 422; audited as `app.keys_published`) and `GET /api/apps/:app/keys?purpose=` (any authenticated service client; 404 when none). Same credentials, CSRF exemption and throttle as the catalog; stored in the new lib-owned table `auth_app_keys`; listed at `GET …/api/apps/keys` (console) and `GET …/apps/keys` (Admin API). `registerAuthHost({ appKeys: false })` turns it off. authkit-client: `manager.publishAppKey({ purpose, jwk })` (background, retried, never rejects) and `manager.appKey({ app, purpose })` (cached 5 min, `null` when none); type `OkpJwk`.
