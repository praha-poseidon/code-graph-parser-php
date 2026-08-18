export type PhpStaticExtractPreset = "symfony-route" | "laravel-route" | "slim-route" | "integration";

export function resolvePhpPresetRules(input: boolean | string[] | undefined): string[] {
  if (!input) return [];
  const requested = input === true ? Object.keys(PRESETS) : input;
  const names = requested.includes("all") ? Object.keys(PRESETS) : requested;
  return [...new Set(names)].flatMap((name) => PRESETS[name as PhpStaticExtractPreset] ?? []);
}

const PRESETS: Record<PhpStaticExtractPreset, string[]> = {
  "symfony-route": [[
    "rule \"PHP Symfony Route Attribute\"",
    "fact http_route",
    "find attribute Route",
    "when attribute @Route on method",
    "let basePath =",
    "  from annotation Route on class take value",
    "  fallback \"\"",
    "let methodPath =",
    "  from attribute take value",
    "let method =",
    "  from attribute take attr(methods)",
    "  fallback \"ANY\"",
    "let handler =",
    "  from method take name",
    "build {",
    "  endpointType: \"HTTP\"",
    "  direction: \"inbound\"",
    "  method: method | normalize upper",
    "  path: concat(basePath, \"/\", methodPath) | normalize httpPath",
    "  handler: handler",
    "}"
  ].join("\n")],
  "laravel-route": [[
    "rule \"PHP Laravel Route Call\"",
    "fact http_route",
    "find call [get,post,put,patch,delete]",
    "when call owner Route",
    "let method =",
    "  from call take method",
    "let prefix =",
    "  from route take prefix",
    "  fallback \"\"",
    "let path =",
    "  from argument[0] take value",
    "let handler =",
    "  from handler take reference",
    "build {",
    "  endpointType: \"HTTP\"",
    "  direction: \"inbound\"",
    "  method: method | normalize upper",
    "  path: concat(prefix, \"/\", path) | normalize httpPath",
    "  handler: handler",
    "}"
  ].join("\n")],
  "slim-route": [[
    "rule \"PHP Slim Route Call\"",
    "fact http_route",
    "find call [get,post,put,patch,delete,options]",
    "when call owner app",
    "let method =",
    "  from call take method",
    "let prefix =",
    "  from route take prefix",
    "  fallback \"\"",
    "let path =",
    "  from argument[0] take value",
    "let handler =",
    "  from handler take reference",
    "build {",
    "  endpointType: \"HTTP\"",
    "  direction: \"inbound\"",
    "  method: method | normalize upper",
    "  path: concat(prefix, \"/\", path) | normalize httpPath",
    "  handler: handler",
    "}"
  ].join("\n")],
  integration: [[
    "rule \"PHP Redis Command\"",
    "fact redis_endpoint",
    "find call [get,set,del,delete]",
    "when call owner redis",
    "let command = from call take method",
    "let keyPattern = from argument[0] take value",
    "build {",
    "  endpointType: \"REDIS\"",
    "  direction: \"outbound\"",
    "  command: command | normalize upper",
    "  keyPattern: keyPattern",
    "}"
  ].join("\n"), [
    "rule \"PHP DB Query\"",
    "fact db_endpoint",
    "find call query",
    "when call owner db",
    "let sql = from argument[0] take value",
    "build {",
    "  endpointType: \"DB\"",
    "  direction: \"outbound\"",
    "  dbOperation: \"QUERY\"",
    "  tableName: sql | regex \"[Ff][Rr][Oo][Mm]\\\\s+([A-Za-z_][A-Za-z0-9_]*)\" group 1",
    "}"
  ].join("\n"), [
    "rule \"PHP Kafka Send\"",
    "fact mq_endpoint",
    "find call send",
    "when call owner kafka",
    "let topic = from argument[0] take value",
    "build {",
    "  endpointType: \"MQ\"",
    "  direction: \"outbound\"",
    "  brokerType: \"KAFKA\"",
    "  operation: \"PRODUCE\"",
    "  topic: topic",
    "}"
  ].join("\n")]
};
