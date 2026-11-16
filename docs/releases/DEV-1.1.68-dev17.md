# DevSpace Portable 1.1.68 dev17

* Computer Use: desktop capture remains full resolution; images over 700 KiB are encoded adaptively before MCP Base64 serialization. Normal PNG is returned unchanged. Large images use JPEG at original resolution where possible, then progressively resize only as required. Explicit desktop-coordinate regions try lossless PNG first.
* Capture metadata records original/transmitted sizes, region origin, image dimensions and scale, including negative virtual-desktop coordinates. The tool reports screenshot failure separately from already completed input actions, so oversized observations cannot cause blind input replay.
* Agent Runtime keeps only two recent visual frames in conversation state, preserving textual tool transactions and current observation. Fallback Computer Use broker wakes on file notification with bounded polling fallback. Action sequences can request the final observation in the same call.
* The host's transport event ceiling is not under Portable's control. Do not retry an oversized image indefinitely; use a smaller region for full-resolution detail. Existing Computer Use permission and active lease remain required.
* Tests exercise large high-entropy images, real Windows encoding, transport envelope size, coordinate mapping, original file integrity and bounded visual history.
