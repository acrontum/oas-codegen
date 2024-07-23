import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { OpenAPIV3 } from 'openapi-types';
import { dirname, join, relative, resolve } from 'path';
import {
  DEBUG,
  TypeGen,
  TypeGenModel,
  TypeGenRef,
  TypeGenTypeField,
  TypeGenTypes,
  Validations,
  dashCase,
  oasKeyToObjectKey,
  oasTypeToTypescript,
  primitives,
} from '../../typegen';

interface ExtraValidations extends Validations {
  allowEmptyValue?: boolean;
  transform?: string;
}

type ModelGen = (schema: TypeGenModel | TypeGenRef, imports: Imports) => string;

type Imports = {
  data: Record<string, Set<string>>;
  add: (from: string, what: string) => void;
  get: () => Record<string, Set<string>>;
};

const typegen = new TypeGen();

const numericTypes: Record<string, true> = {
  integer: true,
  number: true,
  int32: true,
  int64: true,
  float: true,
  double: true,
};

const findModelFields = (model: TypeGenModel<any>, search: string) => {
  const found: TypeGenTypeField[] = [];
  for (const field of model.fields || []) {
    if (field.type === search) {
      found.push(field);
    }
  }
  for (const dep of model.dependencies || []) {
    for (const field of (dep as TypeGenModel).fields || []) {
      if (field.type === search) {
        found.push(field);
      }
    }
  }

  return found;
}

const schemaGen = (model: TypeGenModel<any>, genModel: ModelGen): { content: string; imports: Imports } => {
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
      if (depModel === 'json') {
        findModelFields(model, dep.name)?.forEach(field => field.subtype = 'json');
      } else if (depModel) {
        schema.push(depModel);
      }
    } else if (dep.tType === TypeGenTypes.ref || dep.tType === TypeGenTypes.remoteRef) {
      if (dep.name === componentPath) {
        continue;
      }
      genModel(dep, imports);
    }
  }
  schema.push(genModel(model as TypeGenModel, imports));

  const fullImports: string[] = [];
  Object.keys(imports.get()).forEach((key) => {
    const names = [...imports.data[key].values()].sort();
    if (names.length) {
      fullImports.push(`import { ${names.join(', ')} } from '${key}';`);
    }
  });

  const imprts = fullImports.join('\n');

  return { content: `${imprts ? `${imprts}\n\n` : ''}${schema.join('\n\n')}\n`, imports };
};

const validateBasicTypes = (decorate: (name: string, lib: string) => void, field: TypeGenTypeField): string => {
  let mappedType = oasTypeToTypescript(field.type);

  const validateArray = field.array ? '{ each: true }' : '';
  const validateArrayOpt = validateArray ? `, ${validateArray}` : '';

  switch (field.type) {
    case 'boolean':
      if (field.tType === TypeGenTypes.queryParameter) {
        decorate(`@BooleanTransform()`, './index');
      }
      decorate(`@IsBoolean(${validateArray})`, 'class-validator');
      mappedType = 'boolean';
      break;
    case 'null':
      mappedType = 'null';
      break;
    case 'string':
      switch (field.subtype) {
        case 'date':
        case 'date-time':
          decorate(`@IsDateString(${validateArray})`, 'class-validator');
          mappedType = 'Date';
          break;
        case 'uuid':
          decorate(`@IsUUID(4${validateArrayOpt})`, 'class-validator');
          break;
        case 'uri':
          decorate(`@IsUrl(${validateArray})`, 'class-validator');
          break;
        default:
          decorate(`@IsString(${validateArray})`, 'class-validator');
          if (field.enum) {
            const union = field.enum.map((f) => `'${f}'`);
            decorate(`@IsIn([${union.join(', ')}]${validateArrayOpt})`, 'class-validator');

            return union.join(' | ');
          }
      }
      break;

    case 'number':
    case 'integer':
      mappedType = 'number';
      switch (field.subtype) {
        case 'int32':
        case 'int64':
          decorate(`@IsInt(${validateArray})`, 'class-validator');
          break;
        default:
          decorate(`@IsNumber(${validateArray ? `null, ${validateArray}` : ''})`, 'class-validator');
      }
      break;

    default:
      switch (field.subtype || 'unknown') {
        case 'json':
          mappedType = 'Record<string, unknown>';
          break;
        case 'ref':
        case 'object':
        case 'unknown':
          const peek = typegen.resolveSchemaType(field.type)?.model;
          if ((typeof peek?.type === 'string' && peek.type in primitives) || field.type in primitives) {
            validateBasicTypes(decorate, { ...field, type: peek.type || field.type, enum: peek.enum });
            break;
          }
          decorate(`@ValidateNested(${validateArray})`, 'class-validator');
          decorate(`@Type(() => ${oasTypeToTypescript(field.type)})`, 'class-transformer');
          break;
        default:
          DEBUG({ unknownFieldType: field, subtype: field.subtype });
      }
  }

  return mappedType + (field.validations.nullable ? ' | null' : '');
};

// https://github.com/typestack/class-validator#validation-decorators
const getFieldDecorators = (field: TypeGenTypeField, imports: Imports): { type: string; decorators: string[] } => {
  const decs = new Set<string>();

  if (field.description) {
    decs.add(`  /** ${field.description} */`);
  }

  const decorate = (name: string, lib: string) => {
    decs.add(`  ${name}`);
    imports.add(lib, name.split(/[@(]/)[1]);
  };

  decorate('@Expose()', 'class-transformer');

  if (field.array) {
    decorate('@IsArray()', 'class-validator');
  }

  if (field.validations.required !== true) {
    decorate('@IsOptional()', 'class-validator');
  }

  if (field?.extras?.['x-trimmed'] === true) {
    decorate(`@TrimTransform()`, './index');
  }

  const type = validateBasicTypes(decorate, field);

  for (const [validator, value] of Object.entries(field.validations)) {
    if (validator === 'pattern') {
      decorate(`@Matches(/${value}/)`, 'class-validator');
    }
    if (validator === 'maximum') {
      decorate(`@Max(${value})`, 'class-validator');
    }
    if (validator === 'minimum') {
      decorate(`@Min(${value})`, 'class-validator');
    }
    if (validator === 'maxLength') {
      decorate(`@MaxLength(${value})`, 'class-validator');
    }
    if (validator === 'minLength') {
      decorate(`@MinLength(${value})`, 'class-validator');
    }
    if (validator === 'maxItems') {
      decorate(`@ArrayMaxSize(${value})`, 'class-validator');
    }
    if (validator === 'minItems') {
      decorate(`@ArrayMinSize(${value})`, 'class-validator');
    }
    if (validator === 'nullable' && value === false) {
      decorate(`@IsDefined()`, 'class-validator');
    }
    if (validator === 'allowEmptyValue' && value !== true) {
      decorate(`@IsNotEmpty()`, 'class-validator');
    }
    if (validator === 'transform' && value === 'number') {
      decorate('@IntTransform()', './index');
    }
    if (validator === 'nullable' && value === true) {
      decorate(`@NullTransform()`, './index');
      if (field.validations.required) {
        decorate(`@ValidateIf((o?: { ['${field.name}']?: string | null }) => o?.['${field.name}'] !== null)`, 'class-validator');
      }
    }
  }

  return { type, decorators: [...decs.keys()] };
};

const genModel = (schema: TypeGenModel | TypeGenRef, imports: Imports): string => {
  const schemaname = oasTypeToTypescript(schema.name);
  if (typegen.isTypegenRef(schema)) {
    imports.add('./index', schemaname);
    return '';
  }

  const desc = schema.description ? `/** ${schema.description} */\n` : '';

  let additionalProperties = '';
  const schemaAdditionalProps = (schema.schema as Record<string, unknown>)?.additionalProperties;
  if (schemaAdditionalProps) {
    const recordType = schemaAdditionalProps === true ? 'unknown' : oasTypeToTypescript(schemaAdditionalProps as string);
    additionalProperties = `[key: string | number | symbol]: ${recordType};`;
  }

  if (!schema?.fields?.length) {
    if (schema.tType !== TypeGenTypes.schema && schema.type) {
      const type = numericTypes[schema.type] ? 'number' : schema.type;

      // param / header / etc
      return `${desc}export class ${schemaname} extends ${schema.array ? `Array<${type}>` : `${type}`} {};`;
    }

    if (schemaAdditionalProps) {
      // only json record - this tells schemaGen to ignore type validation
      return 'json';
    }

    if (schema.enum) {
      let values = schema.enum;
      if (schema.type === 'string') {
        values = schema.enum.map((item) => (item === 'null' && schema.validations?.nullable ? 'null' : `'${item}'`));
      }

      return `${desc}export type ${schemaname} = ${values.join(' | ')};`;
    }

    if (schema.type && schema.type in primitives) {
      const format = 'format' in schema.schema ? `/* ${(schema.schema as any).format} */` : '';

      return `${desc}export type ${schemaname} = ${validateBasicTypes(() => null, schema as TypeGenTypeField)}${format};`;
    }
  }

  if (schema.array) {
    return `${desc}export class ${schemaname} extends Array<${oasTypeToTypescript(schema.type as string)}> {};`;
  }

  const def = [desc.slice(0, -1)].filter(Boolean);

  let unionName: string = '';
  const unions: string[] = [];

  if (schema.allOf || schema.anyOf || schema.oneOf) {
    unionName = schema.allOf ? 'AllOf' : schema.anyOf ? 'AnyOf' : 'OneOf';
    imports.add('./index', unionName);

    const key = `${unionName[0].toLowerCase()}${unionName.slice(1)}` as 'allOf' | 'oneOf' | 'anyOf';
    for (const dep of schema[key] || []) {
      const partial = genModel(dep, imports);
      if (partial) {
        def.push(partial);
        def.push('');
      }
      unions.push(oasTypeToTypescript(dep.name));
    }

    if (schema.fields?.length) {
      def.push(`export class ${schemaname}Props {`);
    }
  } else {
    def.push(`export class ${schemaname} {`);
  }

  if (additionalProperties) {
    def.push(`  ${additionalProperties}`);
    def.push('');
  }

  for (const field of schema.fields || []) {
    const { type, decorators } = getFieldDecorators(field, imports);
    def.push(...decorators);
    def.push(
      `  ${oasKeyToObjectKey(field.name)}${field.validations.required === true ? '' : '?'}: ${type || 'unknown'}${field.array ? '[]' : ''};`,
    );
    def.push('');
  }

  if (def[def.length - 1] === '') {
    def[def.length - 1] = '}';
  } else {
    def.push('}');
  }

  if (unionName) {
    imports.add('./index', unionName);

    if (!schema.fields?.length) {
      def.pop();
    } else {
      unions.push(`${schemaname}Props`);
    }

    def.push(`type ${schemaname}UnionAll = ${unions.join(' & ')};`);
    def.push(`export interface ${schemaname} extends ${schemaname}UnionAll {}`);
    def.push('');

    if (schema?.validations?.required?.length) {
      imports.add('./index', 'Require');
      const fields = schema.validations.required.map((r: any) => `'${r}'`).join(', ');
      def.push(`@Require([${fields}])`);
    }

    def.push(`${desc}@${unionName}([${unions.join(', ')}])\nexport class ${schemaname} {}`);
  }

  return def.join('\n');
};

const createDefinitionFile = async (indexExports: Set<string>, outDir: string, model: TypeGenModel<any>) => {
  const fileName = dashCase(model.name);
  const { content } = schemaGen(model, genModel);
  if (content) {
    indexExports.add(`${fileName}.dto`);
    await writeFile(`${join(outDir, fileName)}.dto.ts`, content);
  }
};

const augmentMethodParam = (model: TypeGenModel<OpenAPIV3.ParameterObject>): TypeGenModel<OpenAPIV3.ParameterObject> => {
  for (const field of model?.fields || []) {
    if (field.validations?.required && (field.schema as OpenAPIV3.ParameterObject)?.in === 'query') {
      (field.validations as ExtraValidations).allowEmptyValue = false;
    }
    if (field.type === 'number') {
      (field.validations as ExtraValidations).transform = 'number';
    }
  }

  return model;
};

(async () => {
  if (process.argv.length < 4) {
    throw 'Need moar args (node this.js INPUT_SPEC OUT_DIR)';
  }

  const infile = resolve(process.argv[2]);
  const outDir = resolve(process.argv[3]);

  const indexExports = new Set<string>();
  const indexFilePath = join(outDir, 'index.ts');

  typegen.on(TypeGenTypes.schema, (model) => createDefinitionFile(indexExports, outDir, model));
  typegen.on(TypeGenTypes.methodParam, (model) => createDefinitionFile(indexExports, outDir, augmentMethodParam(model)));

  const schema = require(infile);
  await mkdir(outDir, { recursive: true }).catch(() => null);
  await mkdir(dirname(indexFilePath), { recursive: true }).catch(() => null);

  await typegen.parseSchema(schema);

  const indexExportKeys = [...indexExports.keys()].sort();

  console.log('created files:');
  for (const d of indexExportKeys) {
    console.log(`  ${relative('.', join(outDir, d))}.ts`);
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

import { Transform, TransformOptions } from 'class-transformer';
import { getMetadataStorage } from 'class-validator';
import { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';

export const Require: (fields: string[]) => ClassDecorator =
  (fields: string[]) =>
  <TFunction extends Parameters<ClassDecorator>['0']>(klass: TFunction) => {
    const requiredProps = fields.reduce((acc: Record<string, true>, field) => ((acc[field] = true), acc), {});
    const storage = getMetadataStorage();
    const targetMetadatas = storage
      .getTargetValidationMetadatas(klass, null as unknown as string, true, false)
      .filter((metadata) => !(metadata.propertyName in requiredProps) || metadata.name);
    (storage as unknown as { validationMetadatas: Map<TFunction, ValidationMetadata[]> }).validationMetadatas.set(klass, targetMetadatas);
  };

export const IntTransform = (options?: TransformOptions): PropertyDecorator =>
  Transform(({ value }) => (typeof value === 'undefined' ? value : parseInt(value as string, 10)), options);

export const NullTransform = (options?: TransformOptions): PropertyDecorator =>
  Transform(({ value }) => (value === '' || value === 'null' ? null : (value as unknown)), options);

export const TrimTransform = (options?: TransformOptions): PropertyDecorator =>
  Transform(({ value }) => (typeof value !== 'string' || !value ? null : value.trim()), options);

export const BooleanTransform = (options?: TransformOptions): PropertyDecorator =>
  Transform(({ value }) => {
    const bool = { true: true, false: false }[value as string];

    return typeof bool === 'undefined' ? (value as unknown) : bool;
  }, options);

${indexExportKeys.reduce((i, l) => `${i}export * from './${l}';\n`, '')}`;

  await writeFile(indexFilePath, template);
})().catch((e) => {
  console.trace(e.stack || e);
  process.exit(1);
});
