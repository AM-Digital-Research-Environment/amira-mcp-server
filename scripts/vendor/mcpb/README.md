# Official MCPB manifest schema

`manifest-v0.3.schema.json` is an unmodified copy of
`schemas/mcpb-manifest-v0.3.schema.json` from the npm package
`@anthropic-ai/mcpb@2.1.2`, verified on 2026-10-05. The upstream project is
[modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb/tree/v2.1.2).
The accompanying MIT license is copied from the same package.

SHA-256: `3a0ac9d845711a1b9b17dfa5a52f8b60628239d6a86a9db417206a9efc78592d`

AMIRA uses manifest version 0.3 and validates this draft-07 schema with Ajv.
The local packer additionally requires the explicit `manifest_version` field
(upstream's Zod refinement is absent from the JSON schema), a Node entry point,
matching package/manifest versions and included local files, including a PNG icon.
It creates standard, unsigned ZIP archives with `fflate`, the same ZIP library
used by the upstream packer. It does not implement signing or verification.

When changing manifest versions, obtain the corresponding schema and license
from a verified upstream release, update this provenance and checksum, and run
the packaging tests and a real bundle build. No network fetch is needed during
validation or packaging.
