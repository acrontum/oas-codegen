import { camelCase } from '@acrontum/oas-codegen-parser';
import { config } from './config';
import { Method, Module, Parameter, Decorator as TypegenDecorator } from './parse-typegen';
import { dashCase } from './string-utils';
import { formatOpidType } from './templates';
import {
  addArrayElements,
  addClass,
  addDecorator,
  addMethod,
  addObjectProperty,
  addParameter,
  addSourceFileAtPath,
  addTypeAlias,
  ClassNode,
  CtorNode,
  DecoratableNode,
  DecoratorNode,
  getArrayElements,
  getClasses,
  getConstructors,
  getDecorator,
  getDecoratorArguments,
  getDecoratorName,
  getDecorators,
  getImportDeclarations,
  getMemberName,
  getMethods,
  getObjectProperty,
  getParameters,
  getParameterTypeText,
  getPropertyArray,
  getPropertyInitializerText,
  getReturnTypeText,
  getTypeAlias,
  getTypeAliasType,
  ImportRecord,
  insertConstructor,
  isIdentifier,
  isObjectLiteral,
  MethodNode,
  ObjectLiteralNode,
  ParamNode,
  removeDecorator,
  removeMember,
  setDecoratorArguments,
  setImportDeclarations,
  setIsAsync,
  setParameterType,
  setReturnType,
  setTypeAliasType,
  TsProject,
  TsSourceFile,
} from './ts-ast';

type DecoratorWithTodo = TypegenDecorator & { task: 'create' | 'update' };
interface ImportMap {
  format: () => ImportRecord[];
  list: Record<string, Set<string> & { _namespace?: string }>;
}
export type Modification = { changed: boolean };
export type ServiceMethod = Pick<Method, 'name' | 'returnType' | 'imports'>;

const methodDecorators = {
  Post: true,
  Get: true,
  Delete: true,
  Put: true,
  Patch: true,
  Options: true,
  Head: true,
  All: true,
  Search: true,
} as const;

const addImports = (imports: ImportMap, sets: [string, string][]) => {
  for (const [from, what] of sets) {
    addImport(imports, from, what);
  }
};

const addImport = (imports: ImportMap, from: string, what: string) => {
  (imports.list[from] ||= new Set<string>()).add(what);
};

const dotLastAlphaSorting = (oa: string, ob: string) => {
  const a = oa.replace('type ', '');
  const b = ob.replace('type ', '');

  if (a[0] === '.' && b[0] !== '.') {
    return 1;
  }

  if (b[0] === '.' && a[0] !== '.') {
    return -1;
  }

  return a.localeCompare(b);
};

const updateImports = (source: TsSourceFile, imports: ImportMap) => {
  setImportDeclarations(source, imports.format());
};

const getImportMap = (imports: ImportRecord[]): ImportMap => {
  const mapped: ImportMap = {
    list: {},
    format: () => {
      const formatted: ImportRecord[] = [];
      const moduleSpecifiers = Object.keys(mapped.list).sort(dotLastAlphaSorting);

      for (const moduleSpecifier of moduleSpecifiers) {
        const isTypeOnly = moduleSpecifier.indexOf('type ') === 0;
        const namedImports = [...mapped.list[moduleSpecifier].values()].sort();

        if (mapped.list[moduleSpecifier]?._namespace) {
          formatted.push({
            moduleSpecifier: moduleSpecifier.replace('type ', ''),
            isTypeOnly,
            namespaceImport: mapped.list[moduleSpecifier]._namespace,
            namedImports: [],
          });
          if (!namedImports.length) {
            continue;
          }
        }

        formatted.push({
          moduleSpecifier: moduleSpecifier.replace('type ', ''),
          isTypeOnly,
          namedImports,
        });
      }

      return formatted;
    },
  };

  for (const imp of imports) {
    const from = (imp.isTypeOnly ? 'type ' : '') + imp.moduleSpecifier;
    mapped.list[from] ||= new Set<string>();

    if (imp.namespaceImport) {
      mapped.list[from]._namespace = imp.namespaceImport;
    }

    if (imp.defaultImport) {
      mapped.list[from].add(`default as ${imp.defaultImport}`);
    }

    for (const named of imp.namedImports) {
      mapped.list[from].add(named);
    }
  }

  return mapped;
};

// lazy
const decoratorsEqual = (a: any, b: any) => {
  return JSON.stringify(a) === JSON.stringify(b);
};

const getDecoratorChanges = (existing: readonly DecoratorNode[], desired: TypegenDecorator[]): DecoratorWithTodo[] => {
  const existingDecorators: Record<string, string[]> = {};
  for (const deco of existing) {
    existingDecorators[getDecoratorName(deco)] = getDecoratorArguments(deco).map((a) => a.getText());
  }

  const mutations: DecoratorWithTodo[] = [];

  for (const d of desired) {
    const name = d.name;

    if (!(name in existingDecorators)) {
      mutations.push({ ...d, task: 'create' });
      continue;
    }

    if (!decoratorsEqual(existingDecorators[name], d.content)) {
      mutations.push({ ...d, task: 'update' });
    }
  }

  return mutations;
};

const applyDecoratorChanges = (
  source: TsSourceFile,
  getNode: () => DecoratableNode,
  desired: TypegenDecorator[],
  imports: ImportMap,
): boolean => {
  let changed = false;
  const todo = getDecoratorChanges(getDecorators(getNode()), desired);

  for (const t of todo) {
    changed = true;
    addImport(imports, t.importFrom, t.name);

    if (t.task === 'create') {
      if (t.name in methodDecorators) {
        let methodDecorator: DecoratorNode | undefined;
        while ((methodDecorator = getDecorators(getNode()).find((d) => getDecoratorName(d) in methodDecorators))) {
          removeDecorator(source, methodDecorator);
        }
      }
      addDecorator(source, getNode(), { name: t.name, arguments: t.content || [] });
    } else {
      const decoratorNode = getDecorator(getNode(), t.name);
      if (decoratorNode) {
        setDecoratorArguments(source, decoratorNode, t.content || []);
      }
    }
  }

  return changed;
};

const assertClass = (source: TsSourceFile, name: string): (() => ClassNode) => {
  const getClass = () => getClasses(source)[0];

  if (!getClass()) {
    addClass(source, name);
  }
  if (!getClass()) {
    throw `${__filename} assertClass: Something went wrong`;
  }

  return getClass;
};

const applyParameterChanges = (
  source: TsSourceFile,
  getMethod: () => MethodNode,
  desired: Parameter[],
  imports: ImportMap,
): boolean => {
  let changed = false;
  const paramKey = (param: ParamNode) => {
    const paramDecorators = getDecorators(param);
    return paramDecorators.length ? getDecoratorName(paramDecorators[paramDecorators.length - 1]) : getMemberName(param);
  };

  for (const param of desired) {
    const paramName = param.decorators?.[0]?.name || param.name;
    const getParam = () =>
      getParameters(getMethod()).find((p) => paramKey(p) === paramName || getMemberName(p) === param.name) as ParamNode;

    if (!getParam()) {
      addParameter(source, getMethod(), { name: param.name, type: param.type });
      addImport(imports, param.importFrom, param.type);
      changed = true;
    }

    if (getParameterTypeText(getParam()) !== param.type) {
      setParameterType(source, getParam(), param.type);
      addImport(imports, param.importFrom, param.type);
      changed = true;
    }

    changed = applyDecoratorChanges(source, getParam, param.decorators || [], imports) || changed;

    const returnType = getParameterTypeText(getParam())?.replace(/^Promise<(.*)>$/, (_, x) => x);

    if (returnType?.trim() !== param.type) {
      setParameterType(source, getParam(), param.type);
      changed = true;
    }
  }

  return changed;
};

const assertMethod = (
  source: TsSourceFile,
  getClass: () => ClassNode,
  method: Method,
  findExisting: () => MethodNode | undefined,
  imports: ImportMap,
  serviceName: string | null,
  isService = false,
): 'created' | 'changed' | null => {
  let changed: 'created' | 'changed' | null = null;

  if (!findExisting()) {
    if (config.stubService && serviceName) {
      addMethod(source, getClass(), { name: method.name, statements: [`return this.${serviceName}.${method.name}();`] });
    } else {
      const { statements, imports: importList } = config.getDefaultServiceContent(method);
      addMethod(source, getClass(), { name: method.name, statements });
      addImports(imports, importList);
    }
    changed = 'created';
  }

  const lastByName = () => {
    const named = getMethods(getClass()).filter((m) => getMemberName(m) === method.name);
    return named[named.length - 1];
  };
  const getMethod = () => (changed === 'created' ? lastByName() : findExisting() || lastByName()) as MethodNode;

  const mappedParamDecos: Record<string, DecoratorNode> = {};
  let hasPassthrough = false;
  for (const param of getParameters(getMethod())) {
    for (const deco of getDecorators(param)) {
      mappedParamDecos[getDecoratorName(deco)] = deco;
      hasPassthrough ||= !!getDecoratorArguments(deco).find(
        (a) => isObjectLiteral(a) && getPropertyInitializerText(a, 'passthrough') === 'true',
      );
    }
  }
  const responseHandledManually = ('Res' in mappedParamDecos || 'Response' in mappedParamDecos) && !hasPassthrough;

  if (method.returnType && !responseHandledManually && !isService) {
    const { status, produces } = method.returnType;
    if (produces && !config.isDefaultProduces(produces)) {
      method.decorators.push({ name: 'Header', content: [`'Content-Type'`, `'${produces}'`], importFrom: '@nestjs/common' });
    }

    // default is 200, unless POST -> 201
    if (typeof status === 'number' && !(status === 200 || (method.method === 'post' && status === 201))) {
      method.decorators.push({ name: 'HttpCode', content: [`${status}`], importFrom: '@nestjs/common' });
    }
  }

  // TODO: map to { [parmaname]: { [decoratorname]: decorator } }
  if (applyDecoratorChanges(source, getMethod, method.decorators, imports)) {
    changed ||= 'changed';
  }
  if (applyParameterChanges(source, getMethod, method.methodParams, imports)) {
    changed ||= 'changed';
  }

  const retType = getReturnTypeText(getMethod())?.replace(/^Promise<(.*)>$/, (_, x) => x);

  const returnArray = !!method.returnType?.array;
  const allowedTypes = returnArray
    ? {
        [`Array<${method.returnType?.name}>`]: true,
        [`${method.returnType?.name}[]`]: true,
      }
    : { [`${method.returnType?.name}`]: true };

  // if @Res / @Response decorator present (without { passthrough: true }), we skip this type enforcement
  if (!responseHandledManually && !((retType || '') in allowedTypes)) {
    setReturnType(source, getMethod(), `Promise<${method.returnType?.name}${returnArray ? '[]' : ''}>`);

    if (!config.stubService) {
      setIsAsync(source, getMethod());
    }

    if (method.returnType?.importFrom) {
      addImport(imports, method.returnType.importFrom, method.returnType.name);
    }
    changed ||= 'changed';
  }

  for (const { name, importFrom } of method.imports || []) {
    addImport(imports, importFrom, name);
  }

  return changed;
};

export const modifyOpIdDecorator = async (
  project: TsProject,
  opIdDecoratorPath: string,
  opIds: string[],
): Promise<Modification> => {
  const decoratorSource = await addSourceFileAtPath(project, opIdDecoratorPath);

  const sorted = opIds.slice().sort();
  const opIdType = formatOpidType(sorted, '');

  const typeAlias = getTypeAlias(decoratorSource, 'OperationId');
  if (!typeAlias) {
    addTypeAlias(decoratorSource, { name: 'OperationId', type: opIdType });

    return { changed: true };
  }

  const desired = `,${sorted.join(',')}`;
  const existing = getTypeAliasType(typeAlias)
    ?.split(/['" |\n]+/)
    .sort()
    .reduce((all, opid) => (opid ? `${all},${opid}` : all));
  if (existing === desired) {
    return { changed: false };
  }

  setTypeAliasType(decoratorSource, typeAlias, opIdType.replace(/^\n+/, ''));

  return { changed: true };
};

export const modifyController = async (
  project: TsProject,
  typegenModule: Module,
  controllerPath: string,
): Promise<Modification & { serviceMethods: Method[] }> => {
  let changed = false;

  const controllerSource = await addSourceFileAtPath(project, controllerPath);
  const imports = getImportMap(getImportDeclarations(controllerSource));

  const getCtrl = assertClass(controllerSource, `${typegenModule.controller.name}Controller`);
  changed = applyDecoratorChanges(controllerSource, getCtrl, typegenModule.controller.decorators, imports) || changed;

  const findByOpId = (opid: string) => () =>
    getMethods(getCtrl()).find((m) => {
      const opIdDecorator = getDecorator(m, 'OpId');
      return opIdDecorator && getDecoratorArguments(opIdDecorator)[0]?.getText() === `'${opid}'`;
    });

  const serviceMethods: Method[] = [];

  const getCtor = () => getConstructors(getCtrl())[0] as CtorNode | undefined;
  if (!getCtor()) {
    insertConstructor(controllerSource, getCtrl());
  }
  const serviceType = `${typegenModule.service.name}Service`;

  const serviceParam = getParameters(getCtor() as CtorNode).find((param) => getParameterTypeText(param) === serviceType);
  const serviceName = serviceParam ? getMemberName(serviceParam) : `${camelCase(typegenModule.service.name)}Service`;

  for (const method of typegenModule.controller.methods) {
    const res = assertMethod(controllerSource, getCtrl, method, findByOpId(method.opid), imports, serviceName);
    if (res === null) {
      continue;
    }

    changed = true;

    if (!config.stubService) {
      continue;
    }

    // if was created new, push method name for service gen
    if (res === 'created') {
      serviceMethods.push(method);
    }
  }

  if (serviceMethods?.length) {
    if (!serviceParam) {
      addParameter(controllerSource, getCtor() as CtorNode, {
        name: serviceName,
        type: camelCase(serviceName, true),
        scope: 'private',
      });
      addImport(imports, `./${typegenModule.service.fileName.replace('.ts', '')}`, serviceType);
      changed = true;
    }
  }

  const ctor = getCtor();
  if (ctor && !getParameters(ctor).length) {
    removeMember(controllerSource, ctor);
  }

  if (changed) {
    updateImports(controllerSource, imports);
  }

  return { changed, serviceMethods };
};

export const assertInModuleDecorator = (
  source: TsSourceFile,
  getNode: () => ObjectLiteralNode,
  prop: string,
  inserts: Record<string, string>,
  imports: ImportMap,
): boolean => {
  const getArrayNode = () => getPropertyArray(getObjectProperty(getNode(), prop));

  if (!getObjectProperty(getNode(), prop)) {
    addObjectProperty(source, getNode(), prop, '[]');
  }
  for (const existing of getArrayElements(getArrayNode()!)) {
    if (isIdentifier(existing)) {
      delete inserts[existing.getText()];
    } else if (isObjectLiteral(existing)) {
      const key = getObjectProperty(existing, 'provide')?.getText();
      if (key) {
        delete inserts[key];
      }
    }
  }

  const remaining = Object.keys(inserts).sort();
  if (remaining?.length) {
    addArrayElements(source, getArrayNode()!, remaining);
    for (const importKey of remaining) {
      addImport(imports, inserts[importKey], importKey);
    }

    return true;
  }

  return false;
};

export const modifyService = async (
  project: TsProject,
  typegenModule: Module,
  servicePath: string,
  methods: Method[],
): Promise<Modification> => {
  let changed = false;

  const serviceSource = await addSourceFileAtPath(project, servicePath);
  const imports = getImportMap(getImportDeclarations(serviceSource));

  const getCtrl = assertClass(serviceSource, `${typegenModule.service.name}Service`);

  for (const method of methods) {
    const serviceMethod: Method = {
      name: method.name,
      method: method.method,
      returnType: method.returnType,
      imports: method.imports,
      decorators: [],
      methodParams: [],
      controllerName: '',
      url: '',
      opid: '',
      typegenMethod: method.typegenMethod,
    };
    const findExisting = () => getMethods(getCtrl()).find((m) => getMemberName(m) === serviceMethod.name);
    const methodAdded = assertMethod(serviceSource, getCtrl, serviceMethod, findExisting, imports, null, true);
    if (methodAdded !== null) {
      changed = true;
    }
  }

  if (changed) {
    updateImports(serviceSource, imports);
  }

  return { changed };
};

export const modifyModule = async (
  project: TsProject,
  typegenModule: Module,
  modulePath: string,
  addService: boolean,
): Promise<Modification> => {
  let changed = false;

  const moduleSource = await addSourceFileAtPath(project, modulePath);
  const imports = getImportMap(getImportDeclarations(moduleSource));

  const getCtrl = assertClass(moduleSource, `${typegenModule.name}Module`);
  const getDecoratorArg = () => getDecoratorArguments(getDecorators(getCtrl())[0])[0] as ObjectLiteralNode;

  const moduleName = `./${dashCase(typegenModule.name)}`;
  const ctrlName = `${typegenModule.name}Controller`;
  const ctrlImport = `${moduleName}.controller`;
  const serviceName = `${typegenModule.name}Service`;
  const serviceImport = `${moduleName}.service`;

  if (addService) {
    changed =
      assertInModuleDecorator(moduleSource, getDecoratorArg, 'providers', { [serviceName]: serviceImport }, imports) || changed;
  }
  changed = assertInModuleDecorator(moduleSource, getDecoratorArg, 'controllers', { [ctrlName]: ctrlImport }, imports) || changed;

  if (changed) {
    updateImports(moduleSource, imports);
  }

  return { changed };
};

export const modifyAppModule = async (
  project: TsProject,
  appModulePath: string,
  inserts: Record<string, string>,
): Promise<Modification> => {
  const moduleSource = await addSourceFileAtPath(project, appModulePath);
  const imports = getImportMap(getImportDeclarations(moduleSource));

  const getCtrl = assertClass(moduleSource, 'AppModule');
  const getDecoratorArg = () => getDecoratorArguments(getDecorators(getCtrl())[0])[0] as ObjectLiteralNode;

  if (assertInModuleDecorator(moduleSource, getDecoratorArg, 'imports', inserts, imports)) {
    updateImports(moduleSource, imports);

    return { changed: true };
  }

  return { changed: false };
};
