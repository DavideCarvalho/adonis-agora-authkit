---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-client': minor
---

App permission catalog. Each app publishes what it accepts from the other apps when its web server starts. authkit-client's `service.catalog` controls the source:
- `authz.permissionCatalog()` by default, when `@adonis-agora/authz` is in the app;
- a function of your own;
- `false`, to publish nothing.

The app sends it to `PUT /api/apps/catalog` with its service tenant's id and secret. The server stores it in `auth_app_catalog`, and the CSRF helper exempts that path. The console's "Apps it can call" offers the apps and their capabilities. The catalogs are also listed by `node ace authkit:apps` and by the Admin API at `GET /apps/catalog`.
