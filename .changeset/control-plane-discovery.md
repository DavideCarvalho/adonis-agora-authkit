---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-client': minor
---

Control-plane discovery: apps find where each Agora control plane lives from the IdP instead of one URL env var per control plane.

- `serviceTenants.resources[*].url` in `config/authkit.ts` (absolute `https`, `http` only on localhost, no credentials or fragment) is published in the discovery document as `agora_control_planes` (resource indicator → URL), so a token's audience and the control plane's location live in one table.
- authkit-client: `discoverControlPlane({ issuer, resource })` returns the URL, and `controlPlaneUrl({ issuer, resource })` is its lazy form for config files (`() => Promise<string>` with `peek()` and `refresh()`). The discovery document is cached per issuer; a resource missing from it triggers one refetch (at most every 10 s) before `ControlPlaneNotFoundError` (`E_CONTROL_PLANE_NOT_FOUND`). `discoverEndpoints()` also returns the map as `controlPlanes`.
