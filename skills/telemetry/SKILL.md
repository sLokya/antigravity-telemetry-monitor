---
name: telemetry
description: Open the real-time Antigravity Telemetry & Speed Monitor sidecar panel, or report the current routed model name, Token/s (TPS) generation speed, TTFT latency, and token usage statistics.
---

# Telemetry & Speed Monitor Skill

When the user asks to view real-time status, routed model name, token speed (TPS), or telemetry:

1. **Surface the Sidecar UI Pill**:
   Emit the clickable pill link to open the Auxiliary Pane telemetry dashboard:
   - If running as plugin sidecar: `[打开实时状态与速度监控 (Telemetry HUD)](sidecar://agy-telemetry/monitor/)`
   - Or standalone sidecar: `[打开实时状态与速度监控 (Telemetry HUD)](sidecar://agy-telemetry/)`
2. **Summarize Current Session Metrics**:
   If the user also wants an immediate text summary in chat, query `GetCascadeTrajectoryGeneratorMetadata` on `http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata` for the current conversation ID and report the exact `responseModel`, Streaming TPS, E2E TPS, and TTFT.
