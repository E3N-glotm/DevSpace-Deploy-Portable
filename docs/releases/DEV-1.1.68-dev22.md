# DevSpace Portable 1.1.68 dev22

* Worker and Agent Runtime tasks execute without fixed step limits. Worker tool calls also have no aggregate execution limit. Status and task history still report execution counts.
* Cached clients may continue to pass the legacy step field. The runtime ignores it for new and existing tasks. A persisted Agent paused at the old limit can be resumed manually.
