import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { DEBUG, TypeGenTypes, dashCase, oasKeyToObjectKey, oasTypeToTypescript, primitives } from '../../lib';
import { TypeGen, TypeGenModel, TypeGenRef, TypeGenTypeField } from '../../typegen';

type Imports = {
  data: Record<string, Set<string>>;
  add: (from: string, what: string) => void;
  get: () => Record<string, Set<string>>;
};
type ModelGen = (schema: TypeGenModel | TypeGenRef, imports: Imports) => string;

const typegen = new TypeGen();

const validateBasicTypes = (field: TypeGenTypeField): string => {
  let mappedType = field.type;

  switch (field.type) {
    case 'string':
      switch (field.subtype) {
        case 'date':
        case 'date-time':
          mappedType = 'Date';
          break;
        default:
          if (field.enum) {
            return field.enum.map((f) => `'${f}'`).join(' | ');
          }
      }
      break;

    case 'number':
    case 'integer':
      mappedType = 'number';
      break;

    default:
      switch (field.subtype || 'unknown') {
        case 'ref':
        case 'object':
        case 'unknown':
          const peek = typegen.resolveSchemaType(field.type)?.model;
          if (peek?.type in primitives) {
            validateBasicTypes({ ...field, type: peek.type, enum: peek.enum });
          }
          break;
        default:
          DEBUG({ unknownFieldType: field });
      }
  }

  return oasTypeToTypescript(mappedType);
};

const getFieldDecorators = (field: TypeGenTypeField): { type: string; decorators: string[] } => {
  return {
    type: validateBasicTypes(field),
    decorators: field.description ? [`  /** ${field.description} */`] : [],
  };
};

const numericTypes = {
  integer: true,
  number: true,
  int32: true,
  int64: true,
  float: true,
  double: true,
};

const genModel = (schema: TypeGenModel | TypeGenRef, imports: Imports): string => {
  if (typegen.isTypegenRef(schema)) {
    imports.add('./codegen-index', oasTypeToTypescript(schema.name));
    return '';
  }

  const desc = schema.description ? `/** ${schema.description} */\n` : '';

  let additionalProperties = '';
  if (schema.extras?.additionalProperties) {
    additionalProperties =
      schema.extras?.additionalProperties === true ? 'unknown' : oasTypeToTypescript(schema.extras?.additionalProperties);
  }

  const schemaname = oasTypeToTypescript(schema.name);

  if (!schema?.fields?.length) {
    if (schema.tType !== TypeGenTypes.schema && schema.tType) {
      const type = numericTypes[schema.type] ? 'number' : oasTypeToTypescript(schema.type);

      // param / header / etc
      return `wtf is this\n${desc}export interface ${schemaname} extends ${schema.array ? `Array<${type}>` : `${type}`} {};`;
    }

    if (schema.extras?.additionalProperties) {
      return `${desc}export type ${schemaname} = Record<string, ${additionalProperties}>;`;
    }

    if (schema.enum) {
      let values = schema.enum;
      if (schema.type === 'string') {
        values = schema.enum.map((item) => (item === 'null' && schema.validations.nullable ? 'null' : `'${item}'`));
      }

      return `${desc}export type ${schemaname} = ${values.join(' | ')};`;
    }

    if (schema.type in primitives) {
      const format = 'format' in schema.schema ? ` /* ${schema.schema.format} */` : '';

      return `${desc}export type ${schemaname} = ${validateBasicTypes(schema as TypeGenTypeField)}${format};`;
    }
  }

  if (schema.array) {
    return `${desc}export type ${schemaname} = ${oasTypeToTypescript(schema.type)}[];`;
  }

  const def = [desc.slice(0, -1)].filter(Boolean);

  let unionName: string = '';
  const unions: string[] = [];

  if (schema.allOf || schema.anyOf || schema.oneOf) {
    unionName = schema.allOf ? 'AllOf' : schema.anyOf ? 'AnyOf' : 'OneOf';
    imports.add('./codegen-index', unionName);

    for (const dep of schema[`${unionName[0].toLowerCase()}${unionName.slice(1)}`]) {
      const partial = genModel(dep, imports);
      if (partial) {
        def.push(partial);
        def.push('');
      }
      unions.push(oasTypeToTypescript(dep.name));
    }

    if (schema.fields?.length) {
      def.push(`export interface ${schemaname}Props {`);
    }
  } else {
    def.push(`export interface ${schemaname} {`);
  }

  if (additionalProperties) {
    def.push(`  [key: string | number | symbol]: ${additionalProperties};`);
  }

  for (const field of schema.fields) {
    const { type, decorators } = getFieldDecorators(field);
    def.push(...decorators);
    def.push(
      `  ${oasKeyToObjectKey(field.name)}${field.validations.required ? '' : '?'}: ${type || 'unknown'}${field.array ? '[]' : ''};`,
    );
  }
  if (def[def.length - 1] === '') {
    def[def.length - 1] = '}';
  } else {
    def.push('}');
  }

  if (unionName) {
    const joinProps = schema.fields?.length ? `${schemaname}Props & ` : '';
    if (!joinProps) {
      def.pop();
    }

    if (schema?.validations?.required?.length) {
      imports.add('./codegen-index', 'Require');
      const fields = schema.validations.required.map((r) => `'${r}'`).join(', ');
      def.push(`\nexport type ${schemaname} = Require<${joinProps}${unionName}<[${unions.join(', ')}]>, ${fields}>;`);
    } else {
      def.push(`\nexport type ${schemaname} = ${joinProps}${unionName}<[${unions.join(', ')}]>;`);
    }
  }

  return def.join('\n');
};

const schemaGen = (model: TypeGenModel, genModel: ModelGen): { content: string; imports: Imports } => {
  const schema = [];
  const imports: Imports = {
    data: {},
    add(from, what) {
      this.data[from] ||= new Set<string>();
      this.data[from].add(what);
    },
    get() {
      return this.data;
    },
  };

  const componentPath = `#/${model.location?.replaceAll('.', '/')}`;

  for (const dep of model.dependencies || []) {
    if (dep.tType === TypeGenTypes.schema) {
      const depModel = genModel(dep, imports);
      if (depModel) {
        schema.push(depModel);
      }
    } else if (dep.tType === TypeGenTypes.ref || dep.tType === TypeGenTypes.remoteRef) {
      if (dep.name === componentPath) {
        continue;
      }
      genModel(dep, imports);
    } else {
      console.log('???', dep);
    }
  }
  schema.push(genModel(model, imports));

  const fullImports = [];
  Object.keys(imports.get()).forEach((key) => {
    const names = [...imports.data[key].values()];
    if (names.length) {
      fullImports.push(`import { ${names.sort().join(', ')} } from '${key}';`);
    }
  });

  const imprts = fullImports.join('\n');

  return { content: `${imprts ? `${imprts}\n\n` : ''}${schema.join('\n\n')}\n`, imports };
};

const createDefinitionFile = async (indexExports: Set<string>, outDir: string, model: TypeGenModel) => {
  const fileName = dashCase(model.name);
  const { content } = schemaGen(model, genModel);
  if (content) {
    indexExports.add(`${fileName}`);
    await writeFile(`${join(outDir, fileName)}.ts`, content);
  }
};

(async () => {
  if (process.argv.length < 4) {
    throw 'Need moar args (node this.js INPUT_SPEC OUT_DIR)';
  }

  const infile = resolve(process.argv[2]);
  const outDir = resolve(process.argv[3]);

  const indexExports = new Set<string>();
  const indexFilePath = join(outDir, 'codegen-index.ts');

  typegen.on(TypeGenTypes.schema, (model) => createDefinitionFile(indexExports, outDir, model));
  typegen.on(TypeGenTypes.methodParam, (model) => createDefinitionFile(indexExports, outDir, model));

  const schema = require(infile);
  await mkdir(outDir, { recursive: true }).catch(() => null);
  await mkdir(dirname(indexFilePath), { recursive: true }).catch(() => null);

  await typegen.parseSchema(schema);

  console.log('created files:');
  for (const exported of indexExports.keys()) {
    console.log(`  ${relative('.', join(outDir, exported))}.ts`);
  }

  if (await stat(indexFilePath).catch(() => false)) {
    const matcher = /export \* from '.\/(?<dtofile>[^']+)'/;

    const toDelete = [];
    for (const line of (await readFile(indexFilePath, 'utf8')).split('\n')) {
      const dto = line.match(matcher)?.groups?.dtofile;
      if (dto && !indexExports.has(dto)) {
        toDelete.push(`${join(outDir, dto)}.ts`);
      }
    }
    if (toDelete.length) {
      console.warn(`cleaning up old models:\n  ${toDelete.map((d) => relative('.', d)).join('\n  ')}`);
      await Promise.all(toDelete.map((d) => rm(d, { force: true })));
    }
  }

  const template = `\
/*
* This file is auto generated - do not edit manually.
* It is also used to cleanup unused imports.
*/

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
type XOR<T, U> = (T | U) extends object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U;
export type OneOf<T extends any[]> = T extends [infer Only] ? Only : T extends [infer A, infer B, ...infer Rest] ? OneOf<[XOR<A, B>, ...Rest]> : never;
export type AllOf<T extends any[]> = T extends [infer Only] ? Only : T extends [infer A, ...infer Rest] ? A & AllOf<Rest> : never;
export type AnyOf<T extends any[]> = T extends [infer Only] ? Only : T extends [infer A, ...infer Rest] ? A | AnyOf<Rest> : never;
export type Require<T extends {}, K extends keyof T> = T & Required<Pick<T, K>>;

${[...indexExports.keys()].reduce((i, l) => `${i}export * from './${l}';\n`, '')}`;

  await writeFile(indexFilePath, template);
})().catch((e) => {
  console.trace(e.stack || e);
  process.exit(1);
});
