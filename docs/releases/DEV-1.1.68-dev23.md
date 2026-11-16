# DevSpace Portable 1.1.68 dev23

* Agent Runtime shares one global dispatch setting across the desktop workbench and MCP. It supports automatic, single-model and group execution, with an optional default Worker and per-task overrides.
* Automatic dispatch uses a single Worker for focused work and the default group for distinct parallel work or independent verification. An automatic single-model run can hand off to the default group within the same task.
* The workbench shows the actual routing decision and reason. MCP clients can read the routing policy and accept independently verified single-model results through Agent Runtime.
