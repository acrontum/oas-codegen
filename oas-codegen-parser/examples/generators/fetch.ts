import { OpenAPIV3 } from 'openapi-types';
import { dirname, join, relative, resolve } from 'path';
import {
  TypeGen,
  TypeGenBody,
  TypeGenMethod,
  TypeGenModel,
  TypeGenPathItem,
  TypeGenRef,
  TypeGenResponse,
  TypeGenTypeField,
  primitives,
} from '../../typegen';
import { mkdirSync, writeFileSync } from 'fs';

const typegen = new TypeGen();

const convertComponentName = (refName: string) => refName.replace(/^([$@#\w-]+\/)+/, '');

export const getTypeTypeString = (field: TypeGenTypeField, typegen: TypeGen): string => {
  let mappedType = field.type;

  const complexFieldTypes = ['object', 'unknown'];

  if (field.type === 'string') {
    if (field.subtype === 'date' || field.subtype === 'date-time') {
      mappedType = 'Date';
      return convertComponentName(mappedType);
    }

    return convertComponentName(mappedType);
  }

  if (field.type === 'number') {
    return convertComponentName(mappedType);
  }

  if (field.type === 'integer') {
    mappedType = 'number';
    return convertComponentName(mappedType);
  }

  if (field.type === 'boolean') {
    mappedType = 'boolean';
    return convertComponentName(mappedType);
  }

  if (field.type === 'unknown' || complexFieldTypes.includes(field.subtype ?? '')) {
    const schemaType = typegen.resolveSchemaType(field.type)?.model;

    if (!schemaType?.type) {
      throw new Error(`unknown schema type for field ${field}`);
    }

    if (schemaType?.type in primitives) {
      return getTypeTypeString(
        {
          ...field,
          type: schemaType.type,
          enum: schemaType.enum,
        },
        typegen,
      );
    }
  }

  return `unknown`;
  throw new Error(`could not parse schema type for field ${JSON.stringify(field)}`);
};

const constructPathParamType = (param: TypeGenModel<any>, typeGen: TypeGen): string => {
  const supportPathParamTypes = ['number', 'integer', 'string', 'boolean'];

  if (!supportPathParamTypes.includes(param.type ?? '')) {
    throw new Error(`unsupported path param type ${param.type}`);
  }

  let paramTypeString = `${param.schema.name}`;

  if (param.validations?.required) {
    paramTypeString = `${paramTypeString}:`;
  } else {
    paramTypeString = `${paramTypeString}?:`;
  }

  const typeString = getTypeTypeString(param.schema?.schema, typeGen);

  return `${paramTypeString} ${typeString}`;
};

const constructQueryParamType = (param: TypeGenModel<any>, typeGen: TypeGen): string => {
  let paramTypeString = `${param.schema.name}`;

  if (param.validations?.required) {
    paramTypeString = `${paramTypeString}:`;
  } else {
    paramTypeString = `${paramTypeString}?:`;
  }

  if (param.dependencies?.length) {
    if (param.dependencies?.length > 1) {
      throw new Error('shouldnt have query params with multiple dependencies!');
    }

    if (!typeGen.isTypegenRef(param.dependencies[0])) {
      throw new Error('unsure how to parse dependencies for param.name');
    }

    const importName = convertComponentName(param.dependencies[0]?.name);

    const arrayString = param.array ? '[]' : '';

    return `${paramTypeString} ${importName}${arrayString}`;
  }

  const typeString = getTypeTypeString(param.schema?.schema, typeGen);

  return `${paramTypeString} ${typeString}`;
};

const getPathParamTypes = (
  typegen: TypeGen,
  pathParams: TypeGenRef[],
  referenceMap: Record<string, TypeGenModel<any>>,
): Record<string, string> => {
  const pathParamTypes: Record<string, string> = {};

  for (const pathParamRef of pathParams) {
    if (pathParamRef.tType !== 'REF') {
      // TODO: I doubt I'll ever have a non ref param
      throw new Error('TODO - handle non ref path params');
    }

    const pathParam = referenceMap[pathParamRef.name];

    if (!pathParam) {
      throw new Error(`path param ref ${pathParamRef.name} not found!`);
    }

    const typeString = constructPathParamType(pathParam, typegen);

    pathParamTypes[pathParam.schema.name] = typeString;
  }

  return pathParamTypes;
};

const populatePathWithParams = (
  path: string,
  pathParams: TypeGenRef[],
  referenceMap: Record<string, TypeGenModel<any>>,
): string => {
  let populatedPath = path;

  for (const pathParamRef of pathParams) {
    if (pathParamRef.tType !== 'REF') {
      // TODO: I doubt I'll ever have a non ref param
      throw new Error('TODO - handle non ref path params');
    }

    const pathParam = referenceMap[pathParamRef.name];

    const pathArgumentToReplace = `{${pathParam.schema.name}}`;

    populatedPath = populatedPath.replace(pathArgumentToReplace, `\${encodeURIComponent(pathParams.${pathParam.schema.name})}`);
  }

  return populatedPath;
};

const getQueryParamTypes = (
  typegen: TypeGen,
  methodQueryParams: TypeGenRef[],
  tag: string,
  tagImports: Map<string, Set<string>>,
  referenceMap: Record<string, TypeGenModel<any>>,
): Record<string, string> => {
  const queryParamTypes: Record<string, string> = {};

  for (const queryParamRef of methodQueryParams) {
    if (queryParamRef.tType !== 'REF') {
      // TODO: I doubt I'll ever have a non ref param
      throw new Error('TODO - handle non ref path params');
    }

    const queryParam = referenceMap[queryParamRef.name];

    if (!queryParam) {
      throw new Error(`query param ref ${queryParamRef.name} not found!`);
    }

    if (queryParam.dependencies?.length) {
      if (queryParam.dependencies?.length > 1) {
        throw new Error('shouldnt have query params with multiple dependencies!');
      }

      if (!typegen.isTypegenRef(queryParam.dependencies[0])) {
        throw new Error(`unsure how to parse dependencies for ${queryParam.name}`);
      }

      const importName = convertComponentName(queryParam.dependencies[0]?.name);

      if (!tagImports.has(tag)) {
        tagImports.set(tag, new Set());
      }

      tagImports.get(tag)?.add(importName);
    }

    const typeString = constructQueryParamType(queryParam, typegen);

    queryParamTypes[queryParam.schema.name] = typeString;
  }

  return queryParamTypes;
};

const getRequestBodyType = (
  requestBodies: TypeGenBody[],
  requestBodyInterfaceName: string,
  tag: string,
  tagImports: Map<string, Set<string>>,
): string => {
  if (requestBodies?.length > 1) {
    return 'unknown /* TODO: Implement requests with more than one body for tag ${tag}, requestBodies */';
    throw new Error(
      `TODO: Implement requests with more than one body for tag ${tag}, requestBodies: ${JSON.stringify(requestBodies)}`,
    );
  }

  if (requestBodies?.length !== 1) {
    return '';
  }

  const requestBodyType = requestBodyInterfaceName;

  if (!tagImports.has(tag)) {
    tagImports.set(tag, new Set());
  }

  tagImports.get(tag)?.add(requestBodyType);

  return requestBodyType;
};

const getResponseType = (
  typegen: TypeGen,
  requestResponses: TypeGenResponse[],
  tag: string,
  tagImports: Map<string, Set<string>>,
): string => {
  // TODO: Add support for multiple success responses
  const successResponse = requestResponses.find(({ status }) => status < 300);

  if (!successResponse) {
    return '';
  }

  if (successResponse.payload === null) {
    return 'unknown';
  }

  if (!typegen.isTypegenRef(successResponse.payload)) {
    const typeName = getTypeTypeString(successResponse.payload, typegen);

    return typeName;
  }

  const responseBodyTypeName = convertComponentName(successResponse?.payload?.name ?? '');

  if (!tagImports.has(tag)) {
    tagImports.set(tag, new Set());
  }

  tagImports.get(tag)?.add(responseBodyTypeName);

  return responseBodyTypeName;
};

const createMethodFetchFunction = (
  typegen: TypeGen,
  tagFetchFunctions: Map<string, string[]>,
  tagGetTagFunctions: Map<string, Set<string>>,
  tagImports: Map<string, Set<string>>,
  path: string,
  method: TypeGenMethod,
  referenceMap: Record<string, TypeGenModel<any>>,
): void => {
  const tag = method?.tags?.[0] ?? 'UNKNOWN';

  const pathParams = method.pathParams ?? [];
  const pathParamTypes = getPathParamTypes(typegen, pathParams, referenceMap);
  const populatedPath = populatePathWithParams(path, pathParams, referenceMap);

  const methodQueryParams = method.queryParams ?? [];
  const queryParamTypes = getQueryParamTypes(typegen, methodQueryParams, tag, tagImports, referenceMap);

  const requestBodyInterfaceName = `${method.name}`;
  const methodRequestBodies = method.requestBodies ?? [];
  const requestBodyType = getRequestBodyType(methodRequestBodies, requestBodyInterfaceName, tag, tagImports);

  const requestResponses = method.responses ?? [];
  const requestReturnType = getResponseType(typegen, requestResponses, tag, tagImports);

  const operationId = method.schema.operationId ?? `throw new Error('could not get operationId for ${method.name}')`;
  const tagFetchFunction = generateTagFetchFunction(
    operationId,
    getOperationIdWithoutMethod(operationId),
    method.method,
    method.requestBodies?.[0]?.contentType ?? null,
    populatedPath,
    pathParamTypes,
    queryParamTypes,
    requestBodyType,
    requestReturnType,
  );

  const tagFetchTagGetterFunction = generateTagFetchTagGetter(
    getOperationIdWithoutMethod(operationId),
    populatedPath,
    pathParamTypes,
  );

  if (!tagFetchFunctions.has(tag)) {
    tagFetchFunctions.set(tag, []);
  }

  tagFetchFunctions.get(tag)?.push(tagFetchFunction);

  if (!tagGetTagFunctions.has(tag)) {
    tagGetTagFunctions.set(tag, new Set());
  }

  tagGetTagFunctions.get(tag)?.add(tagFetchTagGetterFunction);

  return;
};

const replaceEndOfStringMatch = (str: string, match: string, replacement: string): string => {
  const lastIndex = str.lastIndexOf(match);

  const isEndOfStringIdx = str.length - match.length;

  if (lastIndex === -1 || !isEndOfStringIdx) {
    return str;
  }

  return `${str.slice(0, lastIndex)}${replacement}`;
};

const getOperationIdWithoutMethod = (operationId: string): string => {
  const methods = ['Get', 'Post', 'Patch', 'Put', 'Delete'];

  let updatedOperationId = operationId;

  for (const method of methods) {
    const replaced = replaceEndOfStringMatch(operationId, method, '');

    if (replaced.length !== operationId.length) {
      updatedOperationId = replaced;
      break;
    }
  }

  return updatedOperationId;
};

const generateTagFetchFunction = (
  operationId: string,
  operationIdWithoutMethod: string,
  method: string,
  contentType: string | null,
  populatedPath: string,
  pathParamTypes: Record<string, string>,
  queryParamTypes: Record<string, string>,
  requestBodyType: string,
  requestReturnType: string,
): string => {
  const pathParams = Object.entries(pathParamTypes);
  const queryParams = Object.entries(queryParamTypes);

  if (requestReturnType === '') {
    requestReturnType = 'void';
  }

  let url = populatedPath;

  let tagFetchFunction = `export const ${operationId}Fetch = (`;

  if (requestBodyType || pathParams.length || queryParams.length) {
    tagFetchFunction += '{\n';

    if (requestBodyType) {
      tagFetchFunction += '  body,\n';
    }

    if (pathParams.length) {
      tagFetchFunction += '  pathParams,\n';
    }

    if (queryParams.length) {
      tagFetchFunction += '  queryParams,\n';
    }

    tagFetchFunction += '  ...requestInitArgs\n';
    tagFetchFunction += '}:{\n';

    if (requestBodyType) {
      tagFetchFunction += `  body: ${requestBodyType},\n`;
    }

    if (pathParams.length) {
      tagFetchFunction += '  pathParams: {\n';

      for (const [, pathParamTypeString] of pathParams) {
        tagFetchFunction += `    ${pathParamTypeString},\n`;
      }

      tagFetchFunction += '  },\n';
    }

    if (queryParams.length) {
      tagFetchFunction += '  queryParams: {\n';

      for (const [, queryParamTypeString] of queryParams) {
        tagFetchFunction += `    ${queryParamTypeString},\n`;
      }

      tagFetchFunction += '  },\n';
    }

    tagFetchFunction += `} & Omit<RequestInit, 'body'>): Promise<HttpResponseType<${requestReturnType}>> => {\n`;

    if (queryParams.length) {
      tagFetchFunction += '  const urlSearchParams = encodeQueryParameters(queryParams);\n\n';

      url += `?\${urlSearchParams}`;
    }
  } else {
    tagFetchFunction += `requestInitArgs: Omit<RequestInit, 'body'>): Promise<HttpResponseType<${requestReturnType}>> => {\n`;
  }

  tagFetchFunction += `\
  const { headers: reqHeaders, ...requestInitArgsRest } = requestInitArgs ?? {};

  let headers: Headers;

  if(reqHeaders) {
    headers = new Headers(reqHeaders);
  } else {
    headers = new Headers();
  }\n`;

  if (contentType) {
    tagFetchFunction += `\n  headers.set('Content-Type', 'application/json');\n`;
  }

  if (requestBodyType) {
    tagFetchFunction += `  const bodyStr = JSON.stringify(body);\n`;
  }

  tagFetchFunction += `  return fetch(\`\${baseUrl}${url}\`, {\n`;

  if (requestBodyType) {
    if (contentType === 'application/json') {
      tagFetchFunction += '    body: JSON.stringify(body),\n';
    } else {
      console.warn(`unhandled content type for ${operationId}`);
      tagFetchFunction += '    body,\n';
    }
  }

  tagFetchFunction += '    headers,\n';

  tagFetchFunction += `    method: '${method.toUpperCase()}',\n`;

  tagFetchFunction += '    ...requestInitArgsRest\n';

  tagFetchFunction += '  });\n\n';

  tagFetchFunction += '};';

  return tagFetchFunction;
};

const generateTagFetchTagGetter = (
  operationIdWithoutMethod: string,
  populatedPath: string,
  pathParamTypes: Record<string, string>,
): string => {
  const pathParams = Object.entries(pathParamTypes);

  let tagGetterFn = `export const ${operationIdWithoutMethod}Tag = (`;

  if (pathParams.length) {
    tagGetterFn += '{\n';

    if (pathParams.length) {
      tagGetterFn += '  pathParams,\n';
    }

    tagGetterFn += '}:{\n';

    if (pathParams.length) {
      tagGetterFn += '  pathParams: {\n';

      for (const [, pathParamTypeString] of pathParams) {
        tagGetterFn += `    ${pathParamTypeString},\n`;
      }

      tagGetterFn += '  },\n';
    }

    tagGetterFn += `}): string => {\n`;
  } else {
    tagGetterFn += `): string => {\n`;
  }

  tagGetterFn += `  return \`${populatedPath}\`;\n`;

  tagGetterFn += `};`;

  return tagGetterFn;
};

const generateFetchFileImportsString = (fetchImports: string[], typeImportPath: string): string => {
  if (!fetchImports.length) {
    return '';
  }

  const template = `\
import {
  ${fetchImports.join(',\n  ')}
} from '${typeImportPath}';\n`;

  return template;
};

const generateTagFetchFunctionsFile = (
  outDir: string,
  typeImportPath: string,
  fetchFileImports: Set<string>,
  indexExports: Set<string>,
  tag: string,
  fetchFunctions: string[],
  getTagFunctions: string[],
): string => {
  if (!fetchFunctions.length) {
    throw new Error(`no fetch functions generated for tag ${tag}`);
  }

  const filename = `${tag}Fetch`;

  indexExports.add(filename);

  const fetchImportsString = generateFetchFileImportsString(Array.from(fetchFileImports), typeImportPath);

  const template = `\
/*
* This file is auto generated - do not edit manually
*/
import { encodeQueryParameters, HttpResponseType } from './codegen-index';
import { baseUrl } from './index';
${fetchImportsString}
${getTagFunctions.join('\n\n')}
${fetchFunctions.join('\n\n')}
`;
  const filepath = join(outDir, `${filename}.ts`);

  writeFileSync(filepath, template);
  return filepath;
};

const generateCodegenIndexFile = (indexExports: Set<string>, filePath: string) => {
  const exports = Array.from(indexExports).map((fileName) => `export * from './${fileName}';`);

  const template = `\
/*
* This file is auto generated - do not edit manually.
*/
export type HttpResponseType<T> = Response & {
  json: () => Promise<T>
};

export const encodeQueryParameters = (queryParameters: string | Record<string, any>): string => {
  return new URLSearchParams(queryParameters).toString();
};

${exports.join('\n')}`;

  writeFileSync(filePath, template);
  return;
};

const fetchGenerator = async (infile: string, outDir: string, typeImportPath: string) => {
  const indexExports = new Set<string>();
  const tagFetchFunctions = new Map<string, string[]>();
  const tagGetTagFunctions = new Map<string, Set<string>>();
  const tagImports = new Map<string, Set<string>>();

  const indexFilePath = join(outDir, 'codegen-index.ts');

  const schema = require(infile);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(indexFilePath), { recursive: true });

  await typegen.parseSchema(schema);

  type ParsedSchemas = {
    referenceMap?: Record<string, TypeGenModel<any>>;
    METHOD?: TypeGenMethod[];
    PATH?: TypeGenPathItem[];
    PATH_PARAMETER?: TypeGenModel<any>[];
    MODEL?: TypeGenModel<any>[];
    SCHEMA?: TypeGenModel<any>[];
    SECURITY_SCHEME?: TypeGenModel<OpenAPIV3.SecuritySchemeObject>[];
  };

  const parsedSchemas = typegen.parsedSchemas as ParsedSchemas;

  for (const method of parsedSchemas.METHOD ?? []) {
    createMethodFetchFunction(
      typegen,
      tagFetchFunctions,
      tagGetTagFunctions,
      tagImports,
      method.path.name,
      method,
      parsedSchemas.referenceMap ?? {},
    );
  }

  const codeGenIndexFilePath = join(outDir, 'codegen-index.ts');

  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(codeGenIndexFilePath), { recursive: true });

  const createdFiles = [];

  for (const [tag, fetchFunctions] of tagFetchFunctions) {
    const fetchFileImports = tagImports.get(tag) ?? new Set();
    const getTagFunctions = Array.from(tagGetTagFunctions.get(tag) ?? []);

    const filepath = generateTagFetchFunctionsFile(
      outDir,
      typeImportPath,
      fetchFileImports,
      indexExports,
      tag,
      fetchFunctions,
      getTagFunctions,
    );

    const relativePath = relative('.', filepath);
    createdFiles.push(relativePath);
  }

  generateCodegenIndexFile(indexExports, codeGenIndexFilePath);
  const relativePath = relative('.', codeGenIndexFilePath);
  createdFiles.push(relativePath);

  console.log(`created ${createdFiles.length} files`);
  console.log(createdFiles.map((filepath) => `  ${filepath}`).join('\n'));
};

// Main
(async () => {
  if (process.argv.length < 5) {
    throw '5 args required';
  }

  const infile = resolve(process.argv[2]);
  const outDir = resolve(process.argv[3]);
  const typeImportPath = process.argv[4];

  await fetchGenerator(infile, outDir, typeImportPath);
})().catch((e) => {
  console.trace(e.stack || e);
  process.exit(1);
});
