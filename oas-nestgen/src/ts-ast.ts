import { readFile, writeFile } from 'fs/promises';
import ts from 'typescript';
import { config } from './config';

export type TsSourceFile = { path: string; text: string; ast: ts.SourceFile; dirty: boolean };
export type TsProject = { files: Map<string, TsSourceFile> };
export type ImportRecord = {
  moduleSpecifier: string;
  isTypeOnly: boolean;
  namespaceImport?: string;
  defaultImport?: string;
  namedImports: string[];
};
export type ClassNode = ts.ClassDeclaration;
export type MethodNode = ts.MethodDeclaration;
export type CtorNode = ts.ConstructorDeclaration;
export type FunctionNode = MethodNode | CtorNode;
export type ParamNode = ts.ParameterDeclaration;
export type DecoratorNode = ts.Decorator;
export type ObjectLiteralNode = ts.ObjectLiteralExpression;
export type TypeAliasNode = ts.TypeAliasDeclaration;
export type DecoratableNode = ClassNode | MethodNode | ParamNode;

const parse = (path: string, text: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

const splice = (file: TsSourceFile, start: number, end: number, text: string): void => {
  file.text = file.text.slice(0, start) + text + file.text.slice(end);
  file.ast = parse(file.path, file.text);
  file.dirty = true;
};

const lineStart = (file: TsSourceFile, pos: number): number => file.text.lastIndexOf('\n', pos - 1) + 1;

const lineIndent = (file: TsSourceFile, pos: number): string => file.text.slice(lineStart(file, pos)).match(/^[ \t]*/)?.[0] || '';

export const createProject = (): TsProject => ({ files: new Map() });

export const createSourceFile = (project: TsProject, path: string, text: string): TsSourceFile => {
  const file: TsSourceFile = { path, text, ast: parse(path, text), dirty: false };
  project.files.set(path, file);

  return file;
};

export const addSourceFileAtPath = async (project: TsProject, path: string): Promise<TsSourceFile> =>
  project.files.get(path) || createSourceFile(project, path, await readFile(path, 'utf8'));

export const getSourceFile = (project: TsProject, path: string): TsSourceFile | undefined => project.files.get(path);

export const getFullText = (file?: TsSourceFile): string | undefined => file?.text;

export const saveProject = async (project: TsProject): Promise<void> => {
  await Promise.all([...project.files.values()].filter((file) => file.dirty).map((file) => writeFile(file.path, file.text)));
};

export const getImportDeclarations = (file: TsSourceFile): ImportRecord[] => {
  const records: ImportRecord[] = [];

  for (const statement of file.ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const clause = statement.importClause;
    const record: ImportRecord = {
      moduleSpecifier: statement.moduleSpecifier.text,
      isTypeOnly: !!clause?.isTypeOnly,
      namedImports: [],
    };

    if (clause?.name) {
      record.defaultImport = clause.name.text;
    }
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        record.namespaceImport = clause.namedBindings.name.text;
      } else {
        record.namedImports = clause.namedBindings.elements.map((element) => element.getText());
      }
    }

    records.push(record);
  }

  return records;
};

const formatImport = (record: ImportRecord): string => {
  const type = record.isTypeOnly ? 'type ' : '';
  if (record.namespaceImport) {
    return `import ${type}* as ${record.namespaceImport} from '${record.moduleSpecifier}';`;
  }

  const named = record.namedImports.join(', ');
  const single = `import ${type}{ ${named} } from '${record.moduleSpecifier}';`;
  if (single.length < config.maxLineLength) {
    return single;
  }

  return `import ${type}{\n${config.indent}${record.namedImports.join(`,\n${config.indent}`)}\n} from '${record.moduleSpecifier}';`;
};

export const setImportDeclarations = (file: TsSourceFile, records: ImportRecord[]): void => {
  const imports = file.ast.statements.filter(ts.isImportDeclaration);
  const insertAt = imports.length ? lineStart(file, imports[0].getStart()) : 0;

  let text = file.text;
  for (const declaration of imports.reverse()) {
    const start = lineStart(file, declaration.getStart());
    let end = declaration.end;
    if (text[end] === '\n') {
      end++;
    }
    text = text.slice(0, start) + text.slice(end);
  }

  let block = records.map(formatImport).join('\n');
  if (block) {
    block += text[insertAt] === '\n' || !text.slice(insertAt) ? '\n' : '\n\n';
  }

  file.text = text.slice(0, insertAt) + block + text.slice(insertAt);
  file.ast = parse(file.path, file.text);
  file.dirty = true;
};

export const getClasses = (file: TsSourceFile): ClassNode[] => file.ast.statements.filter(ts.isClassDeclaration);

export const addClass = (file: TsSourceFile, name: string): void => {
  const prefix = !file.text ? '' : file.text.endsWith('\n') ? '\n' : '\n\n';
  splice(file, file.text.length, file.text.length, `${prefix}export class ${name} {}\n`);
};

export const getTypeAlias = (file: TsSourceFile, name: string): TypeAliasNode | undefined =>
  file.ast.statements.filter(ts.isTypeAliasDeclaration).find((alias) => alias.name.text === name);

export const getTypeAliasType = (alias: TypeAliasNode): string => alias.type.getText();

export const setTypeAliasType = (file: TsSourceFile, alias: TypeAliasNode, type: string): void =>
  splice(file, alias.type.getStart(), alias.type.end, type.replace(/\n/g, `\n${config.indent}`));

export const addTypeAlias = (file: TsSourceFile, alias: { name: string; type: string }): void => {
  const prefix = !file.text ? '' : file.text.endsWith('\n') ? '\n' : '\n\n';
  splice(file, file.text.length, file.text.length, `${prefix}export type ${alias.name} = ${alias.type};\n`);
};

export const getDecorators = (node: ts.Node): readonly DecoratorNode[] =>
  (ts.canHaveDecorators(node) && ts.getDecorators(node)) || [];

export const getDecoratorName = (decorator: DecoratorNode): string =>
  (ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression).getText();

export const getDecorator = (node: ts.Node, name: string): DecoratorNode | undefined =>
  getDecorators(node).find((decorator) => getDecoratorName(decorator) === name);

export const getDecoratorArguments = (decorator: DecoratorNode): ts.Expression[] =>
  ts.isCallExpression(decorator.expression) ? [...decorator.expression.arguments] : [];

export const addDecorator = (
  file: TsSourceFile,
  node: DecoratableNode,
  decorator: { name: string; arguments?: string[] },
): void => {
  const text = `@${decorator.name}(${(decorator.arguments || []).join(', ')})`;
  const existing = getDecorators(node);
  const last = existing[existing.length - 1];

  if (ts.isParameter(node)) {
    if (last) {
      splice(file, last.end, last.end, ` ${text}`);
    } else {
      splice(file, node.getStart(), node.getStart(), `${text} `);
    }

    return;
  }

  if (last) {
    splice(file, last.end, last.end, `\n${lineIndent(file, last.getStart())}${text}`);
  } else {
    const start = node.getStart();
    splice(file, start, start, `${text}\n${lineIndent(file, start)}`);
  }
};

export const removeDecorator = (file: TsSourceFile, decorator: DecoratorNode): void => {
  let start = decorator.getStart();
  let end = decorator.end;

  const startOfLine = lineStart(file, start);
  if (!file.text.slice(startOfLine, start).trim()) {
    const newline = file.text.indexOf('\n', end);
    const rest = newline === -1 ? file.text.slice(end) : file.text.slice(end, newline);
    if (!rest.trim()) {
      start = startOfLine;
      end = newline === -1 ? file.text.length : newline + 1;
    }
  }
  while (file.text[end] === ' ') {
    end++;
  }

  splice(file, start, end, '');
};

export const setDecoratorArguments = (file: TsSourceFile, decorator: DecoratorNode, args: string[]): void => {
  if (ts.isCallExpression(decorator.expression)) {
    splice(file, decorator.expression.arguments.pos, decorator.expression.arguments.end, args.join(', '));
  } else {
    splice(file, decorator.end, decorator.end, `(${args.join(', ')})`);
  }
};

export const getMethods = (klass: ClassNode): MethodNode[] => klass.members.filter(ts.isMethodDeclaration);

export const getConstructors = (klass: ClassNode): CtorNode[] => klass.members.filter(ts.isConstructorDeclaration);

export const getMemberName = (node: MethodNode | ParamNode): string => node.name.getText();

export const addMethod = (file: TsSourceFile, klass: ClassNode, method: { name: string; statements: string[] }): void => {
  const closeBrace = klass.getLastToken()?.getStart() ?? klass.end - 1;
  const body = method.statements.map((statement) => `    ${statement}`).join('\n');
  splice(file, closeBrace, closeBrace, `\n  ${method.name}() {\n${body}\n  }\n`);
};

export const insertConstructor = (file: TsSourceFile, klass: ClassNode): void => {
  splice(file, klass.members.pos, klass.members.pos, `\n  constructor() {\n  }\n`);
};

export const removeMember = (file: TsSourceFile, node: ts.Node): void => {
  const start = lineStart(file, node.getStart());
  let end = node.end;

  const newline = file.text.indexOf('\n', end);
  if (newline !== -1 && !file.text.slice(end, newline).trim()) {
    end = newline + 1;
  }
  if (file.text[start - 1] === '\n' && file.text[end] === '\n') {
    end++;
  }

  splice(file, start, end, '');
};

export const getParameters = (node: FunctionNode): ParamNode[] => [...node.parameters];

export const getParameterTypeText = (param: ParamNode): string | undefined => param.type?.getText();

export const setParameterType = (file: TsSourceFile, param: ParamNode, type: string): void => {
  if (param.type) {
    splice(file, param.type.getStart(), param.type.end, type);
  } else {
    splice(file, param.name.end, param.name.end, `: ${type}`);
  }
};

export const addParameter = (
  file: TsSourceFile,
  node: FunctionNode,
  param: { name: string; type: string; scope?: string },
): void => {
  const text = `${param.scope ? `${param.scope} ` : ''}${param.name}: ${param.type}`;
  const last = node.parameters[node.parameters.length - 1];

  if (last) {
    splice(file, last.end, last.end, `, ${text}`);
  } else {
    splice(file, node.parameters.pos, node.parameters.pos, text);
  }
};

export const getReturnTypeText = (node: FunctionNode): string | undefined => node.type?.getText();

export const setReturnType = (file: TsSourceFile, node: FunctionNode, type: string): void => {
  if (node.type) {
    splice(file, node.type.getStart(), node.type.end, type);
  } else {
    const closeParen = file.text.indexOf(')', node.parameters.end) + 1;
    splice(file, closeParen, closeParen, `: ${type}`);
  }
};

export const setIsAsync = (file: TsSourceFile, method: MethodNode): void => {
  if (!method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    splice(file, method.name.getStart(), method.name.getStart(), 'async ');
  }
};

export const isIdentifier = (node: ts.Node): boolean => ts.isIdentifier(node);

export const isObjectLiteral = (node: ts.Node): node is ObjectLiteralNode => ts.isObjectLiteralExpression(node);

export const getObjectProperty = (node: ObjectLiteralNode, name: string): ts.ObjectLiteralElementLike | undefined =>
  node.properties.find((property) => property.name?.getText() === name);

export const getPropertyInitializerText = (node: ObjectLiteralNode, name: string): string | undefined => {
  const property = getObjectProperty(node, name);

  return property && ts.isPropertyAssignment(property) ? property.initializer.getText() : undefined;
};

export const getPropertyArray = (property?: ts.ObjectLiteralElementLike): ts.ArrayLiteralExpression | undefined =>
  property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer)
    ? property.initializer
    : undefined;

export const getArrayElements = (array: ts.ArrayLiteralExpression): ts.Expression[] => [...array.elements];

export const addArrayElements = (file: TsSourceFile, array: ts.ArrayLiteralExpression, elements: string[]): void => {
  const last = array.elements[array.elements.length - 1];

  if (last) {
    splice(file, last.end, last.end, `, ${elements.join(', ')}`);
  } else {
    splice(file, array.elements.pos, array.elements.pos, elements.join(', '));
  }
};

export const addObjectProperty = (file: TsSourceFile, node: ObjectLiteralNode, name: string, initializer: string): void => {
  const last = node.properties[node.properties.length - 1];

  if (!last) {
    splice(file, node.properties.pos, node.properties.pos, ` ${name}: ${initializer} `);

    return;
  }

  const indent = lineIndent(file, last.getStart());
  if (node.properties.hasTrailingComma) {
    splice(file, last.end + 1, last.end + 1, `\n${indent}${name}: ${initializer},`);
  } else {
    splice(file, last.end, last.end, `,\n${indent}${name}: ${initializer}`);
  }
};
