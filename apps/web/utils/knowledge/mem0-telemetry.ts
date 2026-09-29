// mem0ai reads MEM0_TELEMETRY when its module is evaluated and defaults to
// sending PostHog events. This must be imported before any mem0ai import.
process.env.MEM0_TELEMETRY = "false";
