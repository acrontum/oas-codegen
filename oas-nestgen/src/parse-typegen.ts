import { TypeGenMethod, camelCase } from 'oas-typegen';
import { join } from 'path';
import { Config } from './config';
import { capitalize, dashCase, pascalCase } from './string-utils';

export type Decorator = { name: string; importFrom: string; content?: string[] | null };
export type Import = { name: string; importFrom: string };
export type ReturnType = { name: string; array?: boolean; importFrom?: string } | null;
export type MethodReturnValue = { response: ReturnType; produces: string | null } | null;
export type BodyParamsValue = { body: string; consumes: string | null } | null;

export type Parameter = {
  name: string;
  type: string;
  importFrom: string;
  decorators?: Decorator[];
};

export type Module = {
  name: string;
  fileName: string;
  controller: Controller;
  service: Service;
};

export type Controller = {
  name: string;
  fileName: string;
  methods: Method[];
  constructorParams: Parameter[];
  decorators: Decorator[];
};

export type Service = {
  name: string;
  fileName: string;
  methods: Pick<Method, 'name' | 'returnType' | 'opid'>[];
};

export type Method = {
  name: string;
  decorators: Decorator[];
  methodParams: Parameter[];
  returnType: ReturnType;
  controllerName: string;
  url: string;
  opid: string;
  imports?: Import[];
};

export type ParsedTypegen = { modules: Module[]; opIds: string[] };

export const methodNaming: Record<string, string> = {
  post: 'create',
  get: 'get',
  delete: 'delete',
  patch: 'update',
  put: 'replace',
} as const;

export const getMethodName = (method: TypeGenMethod, basename: string): string => {
  const verb = methodNaming[method.method];
  const name = verb + method.name.replace(capitalize(basename), '').replace(capitalize(method.method), '');

  return name === verb ? verb + basename : name;
};

export const getReturnValue = (typegenMethod: TypeGenMethod, config: Config): MethodReturnValue => {
  const potentialResponses = new Set<TypeGenMethod['responses'][number]>();

  for (const response of typegenMethod.responses) {
    if (response.status >= 200 && response.status <= 299 && response.status !== 204) {
      potentialResponses.add(response);
    }
  }

  const responses = [...potentialResponses.values()];
  if (responses?.length === 1) {
    const response: ReturnType =
      responses[0]?.payload?.tType === 'REF'
        ? { name: responses[0].type, importFrom: config?.typesImport, array: responses[0].array }
        : { name: responses[0].type || 'void', array: responses[0].array };

    return { response, produces: responses[0].contentType || null };
  }

  return null;
};

export const getBodyParams = (typegenMethod: TypeGenMethod): BodyParamsValue => {
  if (typegenMethod.requestBodies?.length === 1) {
    return { body: typegenMethod.requestBodies[0].type, consumes: typegenMethod.requestBodies[0].contentType || null };
  }

  return null;
};

export const namePathParams = (typegenMethod: TypeGenMethod) =>
  typegenMethod.pathParams?.length ? `${typegenMethod.name}Path` : null;

export const nameQueryParams = (typegenMethod: TypeGenMethod) =>
  typegenMethod.queryParams?.length ? `${typegenMethod.name}Query` : null;

export const nameHeadersParams = (typegenMethod: TypeGenMethod) =>
  typegenMethod.headerParams?.length ? `${typegenMethod.name}Headers` : null;

export const isDefaultProduces = (contentType: string) => true;

const basicTypes = {
  string: true,
  boolean: true,
  number: true,
  void: true,
  null: true,
  undefined: true,
  unknown: true,
} as const;

export const extraDecorators = (
  typegenMethod: TypeGenMethod,
  parsed: Method,
): { decorators: Decorator[]; imports?: { name: string; importFrom: string }[] } => {
  if (!parsed.returnType || parsed.returnType.name in basicTypes) {
    return { decorators: [] };
  }

  const extras = {
    decorators: [{ name: 'SerializeOptions', importFrom: '@nestjs/common', content: [`{ type: ${parsed.returnType.name} }`] }],
    imports: parsed.returnType.importFrom ? [{ name: parsed.returnType.name, importFrom: parsed.returnType.importFrom }] : [],
  };

  return extras;
};

export const getMethodControllerName = (typegenMethod: TypeGenMethod): string => {
  return pascalCase(typegenMethod.tags?.[0] || typegenMethod.path.name.split('/').find((p) => !!p) || '');
};

export const getSubPath = (typegenMethod: TypeGenMethod, url: string, root: string): string => {
  return !root ? url : url.replace(new RegExp(`^\/?${dashCase(root)}\/?`), '');
};

export const getControllerDecorators = (controller: Controller): Decorator[] => {
  return [{ name: 'Controller', importFrom: '@nestjs/common', content: [`'${dashCase(controller.name)}'`] }];
};

export const methodFromTypegen = (config: Config, typegenMethod: TypeGenMethod): Method => {
  const opid = typegenMethod.schema.operationId as string;
  const tag = typegenMethod.tags?.[0];
  const url = typegenMethod.path.name.replace(/\}/g, '').replace(/\{/g, ':');
  const method = typegenMethod.method;
  const controllerName = config.getMethodControllerName(typegenMethod);
  const subroute = config.getSubPath(typegenMethod, url, controllerName);
  const name = config.getMethodName(typegenMethod, tag || '');

  const decorators: Decorator[] = [
    { name: capitalize(method), content: subroute ? [`'${subroute}'`] : [], importFrom: '@nestjs/common' },
    { name: 'OpId', content: [`'${opid}'`], importFrom: config.opIdDecoratorImport },
  ];
  const methodParams: Parameter[] = [];

  const pathParams = config.namePathParams(typegenMethod);
  if (pathParams) {
    methodParams.push({
      name: '_path',
      type: pathParams,
      importFrom: config.typesImport,
      decorators: [{ name: 'Param', content: [], importFrom: '@nestjs/common' }],
    });
  }
  const queryParams = config.nameQueryParams(typegenMethod);
  if (queryParams) {
    methodParams.push({
      name: '_query',
      type: queryParams,
      importFrom: config.typesImport,
      decorators: [{ name: 'Query', content: [], importFrom: '@nestjs/common' }],
    });
  }
  const headersParams = config.nameHeadersParams(typegenMethod);
  if (headersParams) {
    methodParams.push({
      name: '_headers',
      type: headersParams,
      importFrom: config.typesImport,
      decorators: [{ name: 'Headers', content: [], importFrom: '@nestjs/common' }],
    });
  }
  const bodyParams = config.getBodyParams(typegenMethod);
  if (bodyParams) {
    methodParams.push({
      name: '_body',
      type: bodyParams.body,
      importFrom: config.typesImport,
      decorators: [{ name: 'Body', content: [], importFrom: '@nestjs/common' }],
    });
  }

  let returnType: { name: string; importFrom?: string } | null = null;
  const returnValue = config.getReturnValue(typegenMethod, config);
  if (returnValue) {
    returnType = returnValue.response;

    if (returnValue.produces && !config.isDefaultProduces(returnValue.produces)) {
      decorators.push({ name: 'Header', content: [`'Content-Type'`, `'${returnValue.produces}'`], importFrom: '@nestjs/common' });
    }
  } else {
    returnType = { name: 'void' };
  }

  const parsedMethod: Method = {
    decorators,
    name,
    methodParams,
    returnType,
    controllerName,
    opid,
    url,
  };
  const extraMethodDecorators = config.extraDecorators(typegenMethod, parsedMethod);
  parsedMethod.decorators.push(...extraMethodDecorators?.decorators);
  parsedMethod.imports = extraMethodDecorators.imports;

  return parsedMethod;
};

export const getControllerFromMethod = (method: Method, controllers: Record<string, Controller>, config: Config): void => {
  controllers[method.controllerName] ||= {
    name: method.controllerName,
    fileName: `${dashCase(method.controllerName)}.controller.ts`,
    constructorParams: [],
    methods: [],
    decorators: [],
  };

  const ctrl = controllers[method.controllerName];
  ctrl.methods.push(method);

  if (config.stubService) {
    const serviceName = camelCase(`${ctrl.name}Service`);
    if (!ctrl.constructorParams.find(({ name }) => name === serviceName)) {
      ctrl.constructorParams.push({
        name: serviceName,
        type: capitalize(serviceName),
        importFrom: `./${dashCase(ctrl.name)}.service`,
      });
    }
  }
};

export const getTypesToGen = (config: Config): ParsedTypegen => {
  const typegen = require(join(process.cwd(), config.typegenPath));

  const result: ParsedTypegen = { modules: [], opIds: [] };
  const controllers: Record<string, Controller> = {};

  const ignoredOpIds = (config.ignoredOpIds || []).reduce((acc: Record<string, boolean>, opid) => {
    acc[opid] = true;

    return acc;
  }, Object.create(null));

  for (const method of typegen.METHOD) {
    if (method.schema.operationId in ignoredOpIds) {
      result.opIds.push(method.schema.operationId);
      continue;
    }
    const parsed = methodFromTypegen(config, method);
    result.opIds.push(parsed.opid);

    getControllerFromMethod(parsed, controllers, config);
  }

  for (const controller of Object.values(controllers)) {
    const controllerDecorators = config.getControllerDecorators(controller);
    if (controllerDecorators?.length) {
      controller.decorators.push(...controllerDecorators);
    }

    result.modules.push({
      name: controller.name,
      fileName: `${dashCase(controller.name)}.module.ts`,
      controller,
      service: {
        name: controller.name,
        fileName: `${dashCase(controller.name)}.service.ts`,
        methods: controller.methods.map(({ name, returnType, opid }) => ({ name, returnType, opid })),
      },
    });
  }

  return result;
};
