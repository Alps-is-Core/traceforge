# Third-party notices

Traceforge is an independently implemented workspace inspired by [REA](https://github.com/morluto/rea) by morluto. It depends on the pinned `rea-agents@6.4.0` package for its deep-analysis CLI and MCP engine. Traceforge is not an official REA release and is not affiliated with its maintainers.

REA is MIT licensed, Copyright (c) 2026 morluto. Its full license is retained in [licenses/REA-MIT.txt](licenses/REA-MIT.txt). REA's own third-party notices and license files remain in the installed dependency. No upstream source files were copied into Traceforge's implementation.

Direct runtime dependencies are `@babel/parser` (MIT), `@modelcontextprotocol/sdk` (MIT), `rea-agents` (MIT, with its own dependency notices), and `zod` (MIT). Development dependencies retain their package licenses. The lockfile records the complete resolved dependency tree. External commercial decompilers retain their own terms and must be supplied separately.
