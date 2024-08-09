import { camelCase } from '@acrontum/oas-codegen-parser';
import {
  ClassDeclaration,
  DecoratableNode,
  Decorator,
  DecoratorStructure,
  ImportDeclaration,
  IndentationText,
  MethodDeclaration,
  ModuledNode,
  ObjectLiteralExpression,
  OptionalKind,
  ParameterDeclaration,
  Project,
  PropertyAssignmentStructure,
  QuoteKind,
  Scope,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import { config } from './config';
import { Method, Module, Parameter, Decorator as TypegenDecorator } from './parse-typegen';
import { dashCase } from './string-utils';
import { formatOpidType } from './templates';

type DecoratorWithTodo = TypegenDecorator & { task: 'create' | 'update'; decoratorNode?: Decorator };
type ImportMapDeclaration = Parameters<ModuledNode['addImportDeclarations']>[0][number];
interface ImportMap {
  format: () => ImportMapDeclaration[];
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
  imports.list[from] ||= new Set<string>();
  imports.list[from].add(what);
};

const dotLastAlphaSorting = (a: string, b: string) => {
  if (a[0] == '.' && b[0] !== '.') {
    return 1;
  }

  if (b[0] == '.' && a[0] !== '.') {
    return -1;
  }

  return a.localeCompare(b);
};

const updateImports = (source: SourceFile | undefined, imports: ImportMap, remove = true) => {
  if (!source) {
    return;
  }

  if (remove) {
    source.getImportDeclarations().forEach((node) => node.remove());
  }

  const toImport = imports.format();
  source.addImportDeclarations(toImport);
};

const getImportMap = (imports: ImportDeclaration[]): ImportMap => {
  const mapped: ImportMap = {
    list: {},
    format: () => {
      let formatted: ImportMapDeclaration[] = [];
      const moduleSpecifiers = Object.keys(mapped.list).sort(dotLastAlphaSorting);

      for (const moduleSpecifier of moduleSpecifiers) {
        const preview = `import { ${[...mapped.list[moduleSpecifier].values()].sort().join(', ')} } from '${moduleSpecifier}';`;
        let prepend = '';
        if (preview.length >= config.maxLineLength) {
          prepend = '\n';
        }
        const namedImports = [...mapped.list[moduleSpecifier].values()].sort().map((x) => `${prepend}${x}`);
        if (prepend) {
          namedImports.push('\n');
        }

        if (mapped.list[moduleSpecifier]?._namespace) {
          formatted.push({
            moduleSpecifier,
            isTypeOnly: false,
            namespaceImport: mapped.list[moduleSpecifier]._namespace,
          });
        }

        formatted.push({
          moduleSpecifier,
          isTypeOnly: false,
          namedImports,
        });
      }

      return formatted;
    },
  };

  for (const imp of imports) {
    const from = imp.getModuleSpecifierValue();
    mapped.list[from] ||= new Set<string>();

    const namespace = imp.getNamespaceImport()?.getText();
    if (namespace) {
      mapped.list[from]._namespace = namespace;
    }

    const defaultImport = imp.getDefaultImport()?.getText();
    if (defaultImport) {
      mapped.list[from].add(`default as ${defaultImport}`);
    }

    const namedImports = imp.getNamedImports()?.map((n) => n.getText()) || [];
    for (const named of namedImports) {
      mapped.list[from].add(named);
    }
  }

  return mapped;
};

const convertDecorators = (from: TypegenDecorator[]): OptionalKind<DecoratorStructure>[] => {
  return from.map((deco) => ({ name: deco.name, arguments: deco.content as any }));
};

// lazy
const decoratorsEqual = (a: any, b: any) => {
  return JSON.stringify(a) === JSON.stringify(b);
};

const getDecoratorChanges = (existing: Decorator[], desired: TypegenDecorator[]): DecoratorWithTodo[] => {
  const existingDecorators: Record<string, Decorator> = {};
  for (const deco of existing) {
    existingDecorators[deco.getFullName()] = deco;
  }

  const mutations: DecoratorWithTodo[] = [];

  for (const d of desired) {
    const name = d.name;

    if (!existingDecorators[name]) {
      mutations.push({ ...d, task: 'create' });
      continue;
    }

    const decoratorNode = existingDecorators[name];
    const args = decoratorNode.getArguments()?.map((a) => a.getText());

    if (!decoratorsEqual(args, d.content)) {
      mutations.push({ ...d, task: 'update', decoratorNode: decoratorNode });
    }
  }

  return mutations;
};

const applyDecoratorChanges = (
  existing: Decorator[],
  desired: TypegenDecorator[],
  node: DecoratableNode,
  imports: ImportMap,
): boolean => {
  let changed = false;
  const todo = getDecoratorChanges(existing, desired);

  for (const t of todo) {
    changed = true;
    addImport(imports, t.importFrom, t.name);

    if (t.task === 'create') {
      if (t.name in methodDecorators) {
        existing.filter((e) => e.getFullName() in methodDecorators).forEach((d) => d.remove());
      }
      node.addDecorator({ name: t.name, arguments: t.content || [] });
    } else {
      t.decoratorNode?.getArguments()?.forEach((node) => t.decoratorNode?.removeArgument(node));
      t.decoratorNode?.addArguments(t.content || []);
    }
  }

  return changed;
};

const assertClass = (source: SourceFile | undefined, name: string): ClassDeclaration => {
  let ctrl = source?.getClasses()?.[0];
  if (ctrl) {
    return ctrl;
  }

  source?.addClass({ name, isExported: true });
  ctrl = source?.getClasses()?.[0];
  if (!ctrl) {
    throw `${__filename} assertClass: Something went wrong`;
  }

  return ctrl;
};

const applyParameterChanges = (
  current: ParameterDeclaration[],
  desired: Parameter[],
  method: MethodDeclaration,
  imports: ImportMap,
): boolean => {
  let changed = false;
  const toCheck: Record<string, ParameterDeclaration> = {};
  for (const param of current) {
    const paramDecorators = param.getDecorators();
    const name = paramDecorators?.[paramDecorators?.length - 1]?.getName() || param.getName();
    toCheck[name] = param;
  }

  for (const param of desired) {
    const paramName = param.decorators?.[0]?.name || param.name;
    let existing = toCheck[paramName];

    if (!existing) {
      existing = method.addParameter({ name: param.name, type: param.type });
      addImport(imports, param.importFrom, param.type);
      changed = true;
    }

    if (existing.getStructure().type !== param.type) {
      existing.setType(param.type);
      addImport(imports, param.importFrom, param.type);
      changed = true;
    }

    changed = applyDecoratorChanges(existing.getDecorators(), param.decorators || [], existing, imports) || changed;

    const returnType = existing
      .getTypeNode()
      ?.getText()
      ?.replace(/^Promise<(.*)>$/, (_, x) => x);

    if (returnType?.trim() !== param.type) {
      existing.setType(param.type);
      changed = true;
    }
  }

  return changed;
};

const assertMethod = (
  klass: ClassDeclaration,
  method: Method,
  existing: MethodDeclaration,
  imports: ImportMap,
  serviceName: string | null,
): { changed: 'created' | 'changed' | null; method: MethodDeclaration } => {
  let changed: 'created' | 'changed' | null = null;

  if (!existing) {
    if (config.stubService && serviceName) {
      existing = klass.addMethod({ name: method.name, statements: [`return this.${serviceName}.${method.name}();`] });
    } else {
      const { statements, imports: importList } = config.getDefaultServiceContent(method);
      existing = klass.addMethod({ name: method.name, statements });
      addImports(imports, importList);
    }
    changed = 'created';
  }

  const mappedParamDecos: Record<string, Decorator> = {};
  const params = existing.getParameters();
  let hasPassthrough = false;
  for (const param of params) {
    const decos = param.getDecorators();
    for (const deco of decos) {
      mappedParamDecos[deco.getName()] = deco;
      hasPassthrough ||= !!(deco.getArguments() as ObjectLiteralExpression[])?.find(
        (a) => (a.getProperty('passthrough')?.getStructure() as PropertyAssignmentStructure)?.initializer === 'true',
      );
    }
  }

  // TODO: map to { [parmaname]: { [decoratorname]: decorator } }
  if (applyDecoratorChanges(existing.getDecorators() || [], method.decorators, existing, imports)) {
    changed ||= 'changed';
  }
  if (applyParameterChanges(existing.getParameters() || [], method.methodParams, existing, imports)) {
    changed ||= 'changed';
  }

  const retType = existing
    .getReturnTypeNode()
    ?.getText()
    ?.replace(/^Promise<(.*)>$/, (_, x) => x);

  const returnArray = !!method.returnType?.array;
  const allowedTypes = returnArray
    ? {
        [`Array<${method.returnType?.name}>`]: true,
        [`${method.returnType?.name}[]`]: true,
      }
    : { [`${method.returnType?.name}`]: true };

  // if @Res / @Response decorator present, this can be ignored.
  if (!(('Res' in mappedParamDecos || 'Response' in mappedParamDecos) && !hasPassthrough) && !((retType || '') in allowedTypes)) {
    existing.setReturnType(`Promise<${method.returnType?.name}${returnArray ? '[]' : ''}>`);

    if (!config.stubService) {
      existing.setIsAsync(true);
    }

    if (method.returnType?.importFrom) {
      addImport(imports, method.returnType.importFrom, method.returnType.name);
    }
    changed ||= 'changed';
  }

  for (const { name, importFrom } of method.imports || []) {
    addImport(imports, importFrom, name);
  }

  return { changed, method: existing };
};

export const createProject = () =>
  new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      quoteKind: QuoteKind.Single,
    },
  });

export const modifyOpIdDecorator = async (
  project: Project,
  opIdDecoratorPath: string,
  opIds: string[],
): Promise<Modification> => {
  project.addSourceFileAtPath(opIdDecoratorPath);
  const decoratorSource = project.getSourceFile(opIdDecoratorPath);

  const sorted = opIds.slice().sort();
  const opIdType = formatOpidType(sorted, '');

  const typeAlias = decoratorSource?.getTypeAlias('OperationId');
  if (!typeAlias) {
    decoratorSource?.addTypeAlias({ name: 'OperationId', type: opIdType, isExported: true });

    return { changed: true };
  }

  const desired = `,${sorted.join(',')}`;
  const existing = (typeAlias.getStructure().type as string)
    ?.split(/['" |\n]+/)
    .sort()
    .reduce((all, opid) => (opid ? `${all},${opid}` : all));
  if (existing === desired) {
    return { changed: false };
  }

  typeAlias.setType(opIdType.replace(/^\n+/, ''));

  return { changed: true };
};

export const modifyController = async (
  project: Project,
  typegenModule: Module,
  controllerPath: string,
): Promise<Modification & { serviceMethods: Method[] }> => {
  let changed = false;

  project.addSourceFileAtPath(controllerPath);
  const controllerSource = project.getSourceFile(controllerPath);
  const imports = getImportMap(controllerSource?.getImportDeclarations() || []);

  const ctrl = assertClass(controllerSource, `${typegenModule.controller.name}Controller`);
  changed = applyDecoratorChanges(ctrl.getDecorators() || [], typegenModule.controller.decorators, ctrl, imports) || changed;

  const existingMethods: Record<string, MethodDeclaration> = {};
  for (const method of ctrl.getMethods()) {
    const opid = method.getDecorator('OpId')?.getArguments()[0]?.getText();
    if (opid) {
      existingMethods[opid] = method;
    }
  }

  const serviceMethods: Method[] = [];

  const ctor = ctrl.getConstructors()[0] || ctrl.insertConstructor(0, {});
  const serviceType = `${typegenModule.service.name}Service`;

  const serviceParam = ctor.getParameters()?.find((param) => param.getStructure().type === serviceType);
  const serviceName = serviceParam?.getName() || `${camelCase(typegenModule.service.name)}Service`;

  for (const method of typegenModule.controller.methods) {
    const res = assertMethod(ctrl, method, existingMethods[`'${method.opid}'`], imports, serviceName);
    if (res.changed === null) {
      continue;
    }

    changed = true;

    if (!config.stubService) {
      continue;
    }

    // if was created new, push method name for service gen
    if (res.changed === 'created') {
      serviceMethods.push(method);
    }
  }

  if (serviceMethods?.length) {
    const ctor = ctrl.getConstructors()[0] || ctrl.insertConstructor(0, {});
    const serviceType = `${typegenModule.service.name}Service`;

    if (!serviceParam) {
      ctor.addParameter({ name: serviceName, type: camelCase(serviceName, true), scope: Scope.Private });
      addImport(imports, `./${typegenModule.service.fileName.replace('.ts', '')}`, serviceType);
      changed = true;
    }
  }

  if (changed) {
    updateImports(controllerSource, imports);
  }

  return { changed, serviceMethods };
};

export const assertInModuleDecorator = (
  node: ObjectLiteralExpression,
  prop: string,
  inserts: Record<string, string>,
  imports: ImportMap,
): boolean => {
  let arrayItems = node.getProperty(prop)?.getChildrenOfKind(SyntaxKind.ArrayLiteralExpression)[0].getElements();
  if (!arrayItems) {
    node.addPropertyAssignment({ name: prop, initializer: '[]' });
    arrayItems = node.getProperty(prop)?.getChildrenOfKind(SyntaxKind.ArrayLiteralExpression)[0].getElements();
  }
  for (const existing of arrayItems || []) {
    if (existing.isKind(SyntaxKind.Identifier)) {
      delete inserts[existing.getText()];
    } else if (existing.isKind(SyntaxKind.ObjectLiteralExpression)) {
      const key = existing.getProperty('provide')?.getText();
      if (key) {
        delete inserts[key];
      }
    }
  }

  const remaining = Object.keys(inserts).sort();
  if (remaining?.length) {
    node.getProperty(prop)?.getChildrenOfKind(SyntaxKind.ArrayLiteralExpression)[0].addElements(remaining);
    for (const importKey of remaining) {
      addImport(imports, inserts[importKey], importKey);
    }

    return true;
  }

  return false;
};

export const modifyService = async (
  project: Project,
  typegenModule: Module,
  servicePath: string,
  methods: Method[],
): Promise<Modification> => {
  let changed = false;

  project.addSourceFileAtPath(servicePath);
  const serviceSource = project.getSourceFile(servicePath);
  const imports = getImportMap(serviceSource?.getImportDeclarations() || []);

  const ctrl = assertClass(serviceSource, `${typegenModule.service.name}Service`);

  const existingMethods: Record<string, MethodDeclaration> = {};
  for (const method of ctrl.getMethods()) {
    existingMethods[method.getName()] = method;
  }

  for (const method of methods) {
    const serviceMethod: Method = {
      name: method.name,
      returnType: method.returnType,
      imports: method.imports,
      decorators: [],
      methodParams: [],
      controllerName: '',
      url: '',
      opid: '',
      typegenMethod: method.typegenMethod,
    };
    const methodAdded = assertMethod(ctrl, serviceMethod, existingMethods[serviceMethod.name], imports, null);
    if (methodAdded.changed !== null) {
      changed = true;
    }
  }

  if (changed) {
    updateImports(serviceSource, imports);
  }

  return { changed };
};

export const modifyModule = async (
  project: Project,
  typegenModule: Module,
  modulePath: string,
  addService: boolean,
): Promise<Modification> => {
  let changed = false;

  project.addSourceFileAtPath(modulePath);
  const moduleSource = project.getSourceFile(modulePath);
  const imports = getImportMap(moduleSource?.getImportDeclarations() || []);

  const ctrl = assertClass(moduleSource, `${typegenModule.name}Module`);
  const decorator = ctrl.getDecorators()[0].getArguments()[0] as ObjectLiteralExpression;

  const moduleName = `./${dashCase(typegenModule.name)}`;
  const ctrlName = `${typegenModule.name}Controller`;
  const ctrlImport = `${moduleName}.controller`;
  const serviceName = `${typegenModule.name}Service`;
  const serviceImport = `${moduleName}.service`;

  if (addService) {
    changed = assertInModuleDecorator(decorator, 'providers', { [serviceName]: serviceImport }, imports) || changed;
  }
  changed = assertInModuleDecorator(decorator, 'controllers', { [ctrlName]: ctrlImport }, imports) || changed;

  if (changed) {
    updateImports(moduleSource, imports);
  }

  return { changed };
};

export const modifyAppModule = async (
  project: Project,
  appModulePath: string,
  inserts: Record<string, string>,
): Promise<Modification> => {
  project.addSourceFileAtPath(appModulePath);
  const moduleSource = project.getSourceFile(appModulePath);
  const imports = getImportMap(moduleSource?.getImportDeclarations() || []);

  const ctrl = assertClass(moduleSource, 'AppModule');
  const decorator = ctrl.getDecorators()[0].getArguments()[0] as ObjectLiteralExpression;

  if (assertInModuleDecorator(decorator, 'imports', inserts, imports)) {
    updateImports(moduleSource, imports);

    return { changed: true };
  }

  return { changed: false };
};
