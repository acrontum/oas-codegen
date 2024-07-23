export const DEBUG = (m: any, p = { depth: null }) => {
  const location = new Error()?.stack?.split('\n')[2].match(/.*at (?<call>[^ ]+).*\/(?<file>[^:]+):(?<line>\d+).*/);
  const here = `${location?.groups?.call} ${location?.groups?.file}:${location?.groups?.line}`;
  console.dir(m, p);
  console.warn(`logged at ${here}\n`);
};

export const camelCase = (str: string, firstCapital: boolean = false) => {
  if (firstCapital) str = ' ' + str;

  return str.replace(/^([A-Z])|[\s-_](\w)/g, (_, p1, p2) => (p2 ? p2.toUpperCase() : p1.toLowerCase()));
};
export const upper = (name: string) => `${name[0].toUpperCase()}${name.slice(1)}`;
export const dashCase = (str: string) => str.replace(/(?:([a-z])([A-Z]))|(?:((?!^)[A-Z])([a-z]))/g, '$1-$3$2$4').toLowerCase();
export const oasTypeToTypescript = (refName: string) => refName.replace(/^([$@#\w-]+\/)+/, '')?.replace(/[^\w_$]/g, '_') || '';
export const oasKeyToObjectKey = (name: string): string =>
  /^[a-zA-Z_\$#][0-9a-zA-Z_\$]*$/.test(name || '') ? name : `'${name}'`;

export const TypeGenTypes = {
  ref: 'REF',
  path: 'PATH',
  method: 'METHOD',
  schema: 'SCHEMA',
  model: 'MODEL',
  parameter: 'PARAMETER',
  queryParameter: 'QUERY_PARAMETER',
  headersParameter: 'HEADER_PARAMETER',
  pathParameter: 'PATH_PARAMETER',
  securityScheme: 'SECURITY_SCHEME',
  response: 'RESPONSE',
  requestBody: 'REQUEST_BODY',
  primitive: 'PRIMITIVE',
  remoteRef: 'REMOTE_REF',
  methodParam: 'METHOD_PARAM',
} as const;

export const ModelTypes = {
  object: 'object',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  null: 'null',
  string: 'string',
  array: 'array',
  http: 'http',
  apiKey: 'apiKey',
  oauth2: 'oauth2',
  openIdConnect: 'openIdConnect',
  basic: 'basic',
  allOf: 'allOf',
  oneOf: 'oneOf',
  anyOf: 'anyOf',
} as const;

export const schemaTypeHints = {
  schemas: 'SchemaObject',
  responses: 'ResponseObject',
  parameters: 'ParameterObject',
  examples: 'ExampleObject',
  requestBodies: 'RequestBodyObject',
  headers: 'HeaderObject',
  securitySchemes: 'SecuritySchemeObject',
  links: 'LinkObject',
  callbacks: 'CallbackObject',
} as const;

export const hintToTypegenType = {
  SchemaObject: TypeGenTypes.schema,
  ResponseObject: TypeGenTypes.response,
  ParameterObject: TypeGenTypes.parameter,
  RequestBodyObject: TypeGenTypes.requestBody,
  HeaderObject: TypeGenTypes.headersParameter,
  SecuritySchemeObject: TypeGenTypes.securityScheme,
} as const;

export const methods = {
  get: true,
  put: true,
  post: true,
  delete: true,
  options: true,
  head: true,
  patch: true,
  trace: true,
} as const;

export const validators = {
  multipleOf: true,
  maximum: true,
  exclusiveMaximum: true,
  minimum: true,
  exclusiveMinimum: true,
  maxLength: true,
  minLength: true,
  pattern: true,
  maxItems: true,
  minItems: true,
  uniqueItems: true,
  maxContains: true,
  minContains: true,
  maxProperties: true,
  minProperties: true,
  required: true,
  dependentRequired: true,
  nullable: true,
};

export const omitFromExtras = {
  type: true,
  format: true,
  schema: true,
  items: true,
  $ref: true,
  properties: true,
  default: true,
  // required: true,
  enum: true,
  description: true,
  additionalProperties: true,
  allOf: true,
  anyOf: true,
  oneOf: true,
};

export const securityTypes = {
  http: true,
  apiKey: true,
  oauth2: true,
  openIdConnect: true,
};

export const primitives = {
  integer: true,
  number: true,
  string: true,
  boolean: true,
  null: true,
};
