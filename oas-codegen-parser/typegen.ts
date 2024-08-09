#!/usr/bin/env node
import { createWriteStream } from 'fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAPIV3 } from 'openapi-types';
import { DEBUG, TypeGenTypes, camelCase, methods, omitFromExtras, primitives, schemaTypeHints, upper, validators } from './lib';
import {
  Method,
  NonRefSchema,
  SchemaComponent,
  SchemaTypeData,
  SchemaTypeHint,
  TypeGenBody,
  TypeGenMethod,
  TypeGenModel,
  TypeGenPathItem,
  TypeGenRef,
  TypeGenResponse,
  TypeGenType,
  TypeGenTypeDep,
  TypeGenTypeField,
  Validations,
} from './types';

export * from './lib';
export * from './types';

export class TypeGen {
  schema: OpenAPIV3.Document;
  callbacks: { [key in TypeGenType]?: ((...args: any[]) => void | Promise<void>)[] } = {};
  customHasher: (schema: SchemaComponent, parsed?: TypeGenRef | TypeGenModel, name?: string) => string;
  schemaRefMap: Record<string, TypeGenRef> = {};
  refContentMap: Record<string, TypeGenModel<any>> = {};
  schemaLocation: string = '';
  parsedSchemas: Record<string, any> = {};

  clearData(): void {
    this.customHasher = null;
    this.schemaRefMap = {};
    this.refContentMap = {};
    this.schemaLocation = '';
    this.parsedSchemas = { referenceMap: this.refContentMap };
  }

  async loadParsed(typegen: typeof this.parsedSchemas, emit = true): Promise<void> {
    this.parsedSchemas = typegen;

    if (!emit) {
      return;
    }

    const events = Object.keys(this.parsedSchemas).filter(
      (key) => key !== 'referenceMap' && key !== 'schemaRefMap',
    ) as TypeGenType[];

    const emitters: Promise<unknown>[] = [];
    for (const event of events) {
      for (const model of this.parsedSchemas[event]) {
        for (const callback of this.callbacks[event] || []) {
          if (typeof callback === 'function') {
            await callback(model);
          }
        }
      }
    }

    await Promise.all(emitters);
  }

  on(event: TypeGenType, callback: (model: any) => any) {
    this.callbacks[event] = this.callbacks[event] || [];
    this.callbacks[event].push(callback);
  }

  async emit(events: TypeGenType[], model: any): Promise<void> {
    for (const event of events) {
      this.parsedSchemas[event] ||= [];
      this.parsedSchemas[event].push(model);

      for (const callback of this.callbacks[event] || []) {
        if (typeof callback === 'function') {
          await callback(model);
        }
      }
    }
  }

  async parseSchema(schema: OpenAPIV3.Document, filename?: string): Promise<void> {
    if (!schema?.openapi?.startsWith('3.')) {
      throw new Error(`Invalid schema - only 3.x is supported: '${schema?.openapi}', ${filename}`);
    }

    this.clearData();
    this.schema = JSON.parse(JSON.stringify(schema));

    this.collectDefinitions();

    for (const [pathName, pathDefiniton] of Object.entries(this.schema.paths)) {
      this.schemaLocation = `paths.${pathName}`;
      const parsedPath = this.parsePathObject(pathName, pathDefiniton);

      for (const method of Object.keys(methods) as Method[]) {
        if (!pathDefiniton[method]) {
          continue;
        }

        this.schemaLocation = `paths.${pathName}.${method}`;
        const parsedMethod = this.parseMethodObject(method, pathDefiniton[method], parsedPath);
        await this.emit([TypeGenTypes.method], parsedMethod);
      }

      await this.emit([TypeGenTypes.path], parsedPath);
    }

    for (const def of Object.values(this.refContentMap)) {
      await this.emit([def.tType, TypeGenTypes.model], def);
    }
  }

  resolveSchemaType<T = SchemaComponent>(type: string): { ref: TypeGenRef; model: TypeGenModel<T> } {
    if (this.schemaRefMap[type]) {
      return { ref: this.schemaRefMap[type], model: this.refContentMap[this.schemaRefMap[type].name] };
    }

    if (this.refContentMap[type]) {
      return { ref: this.schemaRefMap[type], model: this.refContentMap[type] };
    }

    return null;
  }

  isTypegenRef(schema: TypeGenModel | TypeGenRef | TypeGenTypeField): schema is TypeGenRef {
    return schema?.tType === TypeGenTypes.ref || schema?.tType === TypeGenTypes.remoteRef;
  }

  isReferenceObject(schema: SchemaComponent): schema is OpenAPIV3.ReferenceObject {
    return schema && '$ref' in schema;
  }

  isSecuritySchemeObject(schema: SchemaComponent): schema is OpenAPIV3.SecuritySchemeObject {
    if (!('type' in schema)) {
      return false;
    }
    if (typeof schema.type !== 'string') {
      return;
    }

    return ['http', 'apiKey', 'oauth2', 'openIdConnect'].includes(schema.type);
  }

  isParameterObject(schema: SchemaComponent): schema is OpenAPIV3.ParameterObject {
    return 'name' in schema && 'in' in schema;
  }

  getResponseName(
    method: TypeGenMethod | { path: TypeGenPathItem; tags: string[] },
    mediaType: OpenAPIV3.MediaTypeObject,
    data: { contentType: string; status: number },
  ): string {
    const pathName = method.path.name.split('/').pop().replace(/[{}]/g, '');

    return [
      ...new Set<string>([camelCase(method.tags?.[0], true), camelCase(pathName, true)]).values(),
      (method as TypeGenMethod).method ? camelCase((method as TypeGenMethod).method || '', true) : '',
      camelCase(
        data.contentType.replace(/[^a-zA-Z0-9]+([a-z])?/g, (_, x) => x?.toUpperCase() || ' '),
        true,
      ).trim(),
      data.status?.toString(),
    ]
      .filter(Boolean)
      .join('');
  }

  private collectDefinitions(): void {
    const originalHashMethod = this.customHasher;
    this.customHasher = (_: null, parsed?: TypeGenRef | TypeGenModel, name?: string) => name || parsed?.name;

    const assertions: [unknown, TypeGenRef | TypeGenModel, string][] = [];
    for (const [componentName, value] of Object.entries(this.schema.components) as [string, SchemaComponent][]) {
      for (const [name, schema] of Object.entries(value)) {
        let typeHint = schemaTypeHints[componentName] || componentName.toUpperCase();

        this.schemaLocation = `components.${componentName}`;
        const model = this.schemaToType(schema, typeHint, { name });
        assertions.push([schema, model, `#/components/${componentName}/${name}`], [schema, model, JSON.stringify(schema)]);
      }
    }

    for (const [schema, model, name] of assertions) {
      this.assertRef(schema, model, name);
    }

    this.schemaLocation = '';
    this.customHasher = originalHashMethod;
  }

  private getModelHash(schema: SchemaComponent, parsed?: TypeGenRef | TypeGenModel, name?: string): string {
    if (typeof this.customHasher === 'function') {
      return this.customHasher(schema, parsed, name);
    } else {
      return JSON.stringify(schema);
    }
  }

  private getRefFromSchema(schema: SchemaComponent): TypeGenRef {
    const schemaString = this.getModelHash(schema);

    return this.schemaRefMap[schemaString];
  }

  private assertRef<T = NonRefSchema>(
    schema: SchemaComponent,
    parsed: TypeGenRef | TypeGenModel,
    name?: string,
  ): { ref: TypeGenRef; model: TypeGenModel<T> } {
    if (this.isTypegenRef(parsed)) {
      return this.resolveSchemaType<T>(parsed.name);
    }

    if (this.isReferenceObject(schema)) {
      return this.resolveSchemaType<T>(schema.$ref);
    }

    const schemaString = this.getModelHash(schema, parsed, name);

    if (!this.schemaRefMap[schemaString]) {
      this.schemaRefMap[schemaString] = this.schemaRefMap[parsed.name] = { name: parsed.name, tType: TypeGenTypes.ref };
    }

    if (!this.isTypegenRef(parsed)) {
      const { extras = {}, validations = {} } = this.getSchemaValidations(parsed.schema as OpenAPIV3.SchemaObject);
      parsed.validations = { ...parsed.validations, ...validations };
      parsed.extras = { ...parsed.extras, ...extras };
      this.refContentMap[parsed.name] = parsed;
    }

    const ref = this.schemaRefMap[schemaString];

    return this.resolveSchemaType<T>(ref.name);
  }

  private getSchemaValidations(schema: OpenAPIV3.SchemaObject) {
    const validations: Validations = {};
    const extras: Record<string, any> = {};

    // @TODO:
    if (!schema || Array.isArray(schema)) {
      return { validations, extras };
    }

    if ('nullable' in schema) {
      validations.nullable = schema.nullable;
    }
    if ('x-nullable' in schema) {
      validations.nullable = schema['x-nullable'];
    }

    for (const [key, value] of Object.entries(schema).filter(([k]) => !omitFromExtras[k])) {
      if (key in validators) {
        validations[key] = value;
      } else {
        extras[key] = value;
      }
    }

    if ((schema as unknown as OpenAPIV3.ParameterObject).required === true) {
      validations.required = true;
    }

    return { validations, extras };
  }

  private schemaToType(schema: SchemaComponent, hint: SchemaTypeHint = null, data?: SchemaTypeData): TypeGenModel | TypeGenRef {
    if (this.isReferenceObject(schema)) {
      return this.parseReferenceObject(schema);
    }
    if (this.isSecuritySchemeObject(schema)) {
      return this.parseSecuritySchemeObject(schema);
    }
    if (this.isParameterObject(schema)) {
      return this.parseParameterObject(schema, data?.name);
    }

    if (hint === schemaTypeHints.responses || hint === schemaTypeHints.requestBodies) {
      return this.parseResponseObject(
        schema as OpenAPIV3.ReferenceObject | OpenAPIV3.ResponseObject | OpenAPIV3.RequestBodyObject,
        {
          ...data,
          tType: hint === schemaTypeHints.responses ? TypeGenTypes.response : TypeGenTypes.requestBody,
        },
      );
    }

    if (hint && typeof this[`parse${hint}`] === 'function') {
      return this[`parse${hint}`](schema, data);
    }

    return this.parseSchemaObject(schema as OpenAPIV3.SchemaObject, data);
  }

  private deduplicateSchema(schema: OpenAPIV3.SchemaObject): { model: TypeGenModel; ref: TypeGenRef } {
    const existing = this.getRefFromSchema(schema);
    if (existing && this.resolveSchemaType(existing.name)) {
      return this.resolveSchemaType(existing.name);
    }
  }

  private parseSchemaObject(schema: OpenAPIV3.SchemaObject, data: SchemaTypeData): TypeGenModel | TypeGenRef {
    const existing = this.deduplicateSchema(schema);
    if (existing?.ref) {
      return existing.ref;
    }

    const parsed: TypeGenModel = {
      name: data?.name,
      location: `${this.schemaLocation}.${data?.name}`,
      tType: TypeGenTypes.schema,
      fields: [],
      dependencies: data?.deps || [],
      schema: schema,
      description: schema.description,
      validations: {},
      extras: {},
    };

    for (const [key, value] of Object.entries(schema).filter(([k]) => !omitFromExtras[k])) {
      if (key in validators) {
        parsed.validations[key] = value;
      } else {
        parsed.extras = parsed.extras || {};
        parsed.extras[key] = value;
      }
    }

    if (schema.type === 'array') {
      this.schemaLocation += '.items';
      const items = this.schemaToType(schema.items, null, { name: `${parsed.name}Items`, deps: parsed.dependencies });
      this.schemaLocation = this.schemaLocation.replace(/\.items$/, '');
      parsed.array = true;
      parsed.type = items.name;
      if (!this.isTypegenRef(items) && items.type in primitives) {
        parsed.type = items.type;
      }
      delete (items as TypeGenModel).dependencies;

      parsed.dependencies.push(items);

      return parsed;
    }

    if (schema.additionalProperties && schema.additionalProperties !== true) {
      const extra = this.schemaToType(schema.additionalProperties, null, {
        name: `${parsed.name}Extras`,
        deps: parsed.dependencies,
      });
      parsed.extras = parsed.extras || {};
      parsed.extras.additionalProperties = extra.name;
      delete (extra as TypeGenModel).dependencies;
      parsed.dependencies.push(extra);
    }

    const isSimple = !['properties', 'oneOf', 'allOf', 'anyOf'].find((prop) => prop in schema);
    if (isSimple) {
      if (!('type' in schema) || typeof schema.type !== 'string') {
        return parsed;
      }

      if (schema.type !== 'object') {
        parsed.type = schema.type;
      }

      if (schema.enum) {
        parsed.enum = schema.enum;
      }

      return parsed;
    }

    const required = data.required || ({} as Record<string, boolean>);
    if ('required' in schema && Array.isArray(schema.required)) {
      schema.required.forEach((key) => (required[key] = true));
    }

    this.parseSchemaProps(schema, parsed, required);
    this.parseCombinators(schema, parsed, required);

    return parsed;
  }

  private parseSchemaProps(schema: OpenAPIV3.NonArraySchemaObject, parsed: TypeGenModel, required: Record<string, boolean>) {
    for (const [name, prop] of Object.entries(schema.properties || {})) {
      const field: TypeGenTypeField = {
        // name: /^[a-zA-Z_\$#][0-9a-zA-Z_\$]*$/.test(name) ? name : `'${name}'`,
        name,
        tType: TypeGenTypes.schema,
        type: (prop as OpenAPIV3.SchemaObject).type,
        subtype: (prop as OpenAPIV3.SchemaObject).format,
        validations: {},
        description: (prop as OpenAPIV3.SchemaObject).description,
      };

      if ('default' in prop) {
        field.default = prop.default;
      }

      if (this.isReferenceObject(prop)) {
        const ref = this.parseReferenceObject(prop);
        parsed.dependencies.push(ref);
        field.type = ref.name;
        field.subtype = 'object';
        field.tType = ref.tType;
      } else if (prop.type === 'array' && (prop.items as OpenAPIV3.SchemaObject).type in primitives) {
        field.type = (prop.items as OpenAPIV3.SchemaObject).type;
        field.array = true;
        field.subtype = (prop.items as OpenAPIV3.SchemaObject).format;
        if (!field.subtype) {
          delete field.subtype;
        }
      } else if (prop.type === 'array' || prop.type === 'object' || !prop.type) {
        if ((prop as any).schema) {
          console.trace('should never happen', schema, prop);
          throw new Error('err');
        }

        const subschema = this.schemaToType((prop as OpenAPIV3.ArraySchemaObject).items || prop, null, {
          name: `${parsed.name}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
          deps: parsed.dependencies,
        });
        field.tType = subschema.tType;
        field.type = subschema.name;

        if (subschema.tType !== TypeGenTypes.primitive) {
          delete (subschema as TypeGenModel).dependencies;
          parsed.dependencies.push(subschema);
          field.subtype = 'object';
        }
      }

      if ((prop as OpenAPIV3.SchemaObject).type === 'array') {
        field.array = true;
      }

      if ('enum' in prop) {
        field.enum = prop.enum;
      }

      if (!this.isReferenceObject(prop)) {
        const { validations, extras } = this.getSchemaValidations(prop);
        field.validations = { ...field.validations, ...validations };
        field.extras = { ...field.extras, ...extras };
      }

      if (name in required) {
        // parsed.validations.required = true;
        field.validations.required = true;
      }

      parsed.fields.push(field);
    }
  }

  private parseCombinators(
    schema: OpenAPIV3.NonArraySchemaObject,
    parsed: TypeGenModel<SchemaComponent>,
    required: Record<string, boolean>,
  ): void {
    const mapSubschema = (
      name: string,
      subSchema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    ): TypeGenRef | TypeGenModel => {
      const model = this.schemaToType(subSchema, null, { name, deps: parsed.dependencies });
      // this.assertRef(schema, model);
      if ('dependencies' in model) {
        model.dependencies = [];
      }

      return model;
    };

    if ('allOf' in schema) {
      parsed.allOf = schema.allOf.map((s, i) => mapSubschema(`${parsed.name}AllOf${i}`, s));
    }
    if ('anyOf' in schema) {
      parsed.anyOf = schema.anyOf.map((s, i) => mapSubschema(`${parsed.name}AnyOf${i}`, s));
    }
    if ('oneOf' in schema) {
      parsed.oneOf = schema.oneOf.map((s, i) => mapSubschema(`${parsed.name}OneOf${i}`, s));
      // discrinator
    }
  }

  private parseReferenceObject(schema: OpenAPIV3.ReferenceObject): TypeGenRef {
    const isLocal = ['.', '#', '/'].includes(schema.$ref[0]);

    if (!isLocal) {
      return { name: schema.$ref, tType: TypeGenTypes.remoteRef };
    }

    return this.schemaRefMap[schema.$ref] || { name: schema.$ref, tType: TypeGenTypes.ref };
  }

  private parseSecuritySchemeObject(schema: OpenAPIV3.SecuritySchemeObject): TypeGenModel<OpenAPIV3.SecuritySchemeObject> {
    return {
      name: `Auth${upper(schema.type)}`,
      location: `${this.schemaLocation}.Auth${upper(schema.type)}`,
      tType: TypeGenTypes.securityScheme,
      type: schema.type,
      schema: schema,
      description: schema.description,
    };
  }

  private parseResponseObject(
    schema: OpenAPIV3.ReferenceObject | OpenAPIV3.ResponseObject | OpenAPIV3.RequestBodyObject,
    data: SchemaTypeData<{ tType: TypeGenType }>,
  ): TypeGenModel<OpenAPIV3.ResponseObject | OpenAPIV3.RequestBodyObject> {
    if (this.isReferenceObject(schema)) {
      schema = this.resolveSchemaType<OpenAPIV3.ResponseObject>(schema.$ref)?.model?.schema;
      if (!schema) {
        DEBUG({ schema, data });
        throw 'did not parse response';
      }
    }

    const parsed: TypeGenModel<OpenAPIV3.ResponseObject | OpenAPIV3.RequestBodyObject> = {
      name: data.name,
      tType: data.tType,
      schema,
      location: `${this.schemaLocation}`,
      validations: (schema as OpenAPIV3.RequestBodyObject).required ? { required: true } : {},
      extras: {},
    };

    if ('headers' in schema) {
      for (const [name, param] of Object.entries(schema.headers || {})) {
        parsed.extras.headers ||= {};
        if (this.isReferenceObject(param)) {
          parsed.extras.headers[name] = this.resolveSchemaType(param.$ref).ref;
          continue;
        }
        const headerSchema = { ...param, name, in: 'headers' };
        parsed.extras.headers[name] = this.assertRef(headerSchema, this.parseParameterObject(headerSchema)).ref;
      }
    }

    return parsed;
  }

  private parseMethodResponse(
    method: TypeGenMethod,
    responseSchema: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject,
    data: SchemaTypeData<{ status: number }>,
  ): TypeGenResponse[] {
    if (this.isReferenceObject(responseSchema)) {
      responseSchema = this.resolveSchemaType<OpenAPIV3.ResponseObject>(responseSchema.$ref)?.model?.schema;
      if (!responseSchema) {
        DEBUG({ method, responseSchema, data });
        throw 'did not parse response';
      }
    }

    const headers: Record<string, TypeGenRef> = {};
    for (const [name, param] of Object.entries(responseSchema.headers || {})) {
      if (this.isReferenceObject(param)) {
        headers[name] = this.resolveSchemaType(param.$ref).ref;
        continue;
      }
      const headerSchema = { ...param, name, in: 'headers' };
      headers[name] = this.assertRef(headerSchema, this.parseParameterObject(headerSchema)).ref;
    }

    if (!responseSchema.content) {
      return [
        {
          name: this.getResponseName(method, null, { ...data, contentType: '' }),
          status: data.status,
          tType: TypeGenTypes.response,
          type: null,
          payload: null,
          headers,
          description: responseSchema.description,
          contentType: null,
        },
      ];
    }

    const parsed: TypeGenResponse[] = [];
    for (const [contentType, payload] of Object.entries(responseSchema.content || {})) {
      const name = this.getResponseName(method, payload, { ...data, contentType });

      if ('type' in payload.schema && payload.schema.type in primitives) {
        const response: TypeGenResponse = {
          name,
          status: data.status,
          tType: TypeGenTypes.response,
          type: payload.schema.type,
          payload: null,
          headers,
          description: responseSchema.description,
          contentType,
        };
        parsed.push(response);

        continue;
      }

      if ('type' in payload.schema && payload.schema.type === 'array') {
        if (!('items' in payload.schema)) {
          DEBUG({ method, responseSchema, data, payload });
          throw 'is array type without items?';
        }

        const itemType = this.schemaToType(payload.schema.items, null, { name });
        const payloadSchema = this.assertRef(payload.schema.items, itemType, itemType.name || name).ref;

        const response: TypeGenResponse = {
          name: itemType.name || name,
          status: data.status,
          tType: TypeGenTypes.response,
          type: payloadSchema.name,
          payload: payloadSchema,
          headers,
          description: responseSchema.description,
          contentType,
          array: true,
        };
        parsed.push(response);

        continue;
      }

      const payloadSchema = this.assertRef(payload.schema, this.schemaToType(payload.schema, null, { name }), name).ref;

      const response: TypeGenResponse = {
        name,
        status: data.status,
        tType: TypeGenTypes.response,
        type: payloadSchema.name,
        payload: payloadSchema,
        headers,
        description: responseSchema.description,
        contentType,
      };
      parsed.push(response);
    }

    return parsed;
  }

  private parseMethodRequestBody(
    method: TypeGenMethod,
    request: OpenAPIV3.ReferenceObject | OpenAPIV3.RequestBodyObject,
  ): TypeGenBody[] {
    const schema = this.isReferenceObject(request)
      ? this.resolveSchemaType<OpenAPIV3.RequestBodyObject>(request.$ref).model.schema
      : request;

    const parsed: TypeGenBody[] = [];
    for (const [contentType, payload] of Object.entries(schema.content || {})) {
      const name = this.getResponseName(method, payload, { contentType, status: null });
      const payloadSchema = this.assertRef(payload.schema, this.schemaToType(payload.schema, null, { name }), name).ref;

      const response: TypeGenBody = {
        name,
        tType: TypeGenTypes.requestBody,
        payload: payloadSchema,
        type: payloadSchema.name,
        description: schema.description,
        contentType,
      };
      parsed.push(response);
    }

    return parsed;
  }

  private parseParameterObject(schema: OpenAPIV3.ParameterObject, name: string = null): TypeGenModel<OpenAPIV3.ParameterObject> {
    const param: TypeGenModel<OpenAPIV3.ParameterObject> = {
      name: name || schema.name,
      schema,
      location: `${this.schemaLocation}.${name}`,
      tType: TypeGenTypes[`${schema.in}Parameter`] ?? TypeGenTypes.parameter,
      validations: {},
      extras: {},
      description: schema.description,
      // subtype: [param.type, param.format].filter(Boolean).join(':'),
    };

    const parsed = this.schemaToType(schema.schema, null, { name: camelCase(`${schema.in} ${schema.name}`, true) });

    if (this.isTypegenRef(parsed)) {
      param.dependencies = [parsed];
      param.type = parsed.name;
    } else {
      param.type = parsed.type;
      param.array = parsed.array;
      param.validations = parsed.validations;
      param.extras = parsed.extras;
      param.dependencies = parsed.dependencies?.filter?.((dep) => this.isTypegenRef(dep));
    }

    if (schema.required) {
      param.validations.required = schema.required;
    }

    return param;
  }

  private parsePathObject(name: string, definiton: OpenAPIV3.PathItemObject): TypeGenPathItem {
    return {
      name,
      tType: TypeGenTypes.path,
      schema: definiton,
      methods: [],
    };
  }

  private parseMethodObject(method: Method, schema: OpenAPIV3.OperationObject, parsedPath: TypeGenPathItem): TypeGenMethod {
    const opItem: TypeGenMethod = {
      name: camelCase(schema.operationId, true),
      method,
      tType: TypeGenTypes.method,
      schema,
      path: parsedPath,
      tags: schema.tags,
      description: schema.description,
      pathParams: [],
      headerParams: [],
      queryParams: [],
      responses: [],
      security: [],
      pathObject: null,
      headerObject: null,
      queryObject: null,
    };
    parsedPath.methods.push({ ...opItem, path: `<circular ${parsedPath.name}>` });

    for (const param of schema.parameters || []) {
      const parsed = this.schemaToType(param, schemaTypeHints.parameters);
      const { model, ref } = this.assertRef<OpenAPIV3.ParameterObject>(param, parsed);

      if (model.schema.in === 'path') {
        opItem.pathParams.push(ref);
      } else if (model.schema.in === 'header') {
        opItem.headerParams.push(ref);
      } else if (model.schema.in === 'query') {
        opItem.queryParams.push(ref);
      }
    }

    opItem.pathObject = this.buildParamObject(opItem.pathParams, `${opItem.name}Path`);
    opItem.headerObject = this.buildParamObject(opItem.headerParams, `${opItem.name}Headers`);
    opItem.queryObject = this.buildParamObject(opItem.queryParams, `${opItem.name}Query`);

    for (const [code, response] of Object.entries(schema.responses || {})) {
      this.schemaLocation = `paths.${parsedPath.name}.${method}.responses`;
      const responses = this.parseMethodResponse(opItem, response, { status: parseInt(code, 10) });
      if (responses?.length) {
        opItem.responses.push(...responses);
      }
    }

    if (schema.requestBody) {
      this.schemaLocation = `paths.${parsedPath.name}.${method}.requestBody`;
      const bodies = this.parseMethodRequestBody(opItem, schema.requestBody);
      if (bodies?.length) {
        opItem.requestBodies ||= [];
        opItem.requestBodies.push(...bodies);
      }
    }

    return opItem;
  }

  private buildParamObject(params: TypeGenRef[], name: string): TypeGenRef | null {
    if (!params?.length) {
      return null;
    }

    const dependencies: TypeGenTypeDep[] = [];
    const fields: TypeGenTypeField[] = [];

    for (const param of params) {
      const model = this.resolveSchemaType<OpenAPIV3.ParameterObject>(param.name).model;
      const field: TypeGenTypeField = {
        ...model,
        name: model.schema.name,
        type: model.type,
        validations: model.validations,
        subtype:
          (model.schema.schema as OpenAPIV3.SchemaObject)?.format ||
          ((model.schema.schema as OpenAPIV3.ArraySchemaObject)?.items as OpenAPIV3.SchemaObject)?.format,
        enum: model.enum || (model.schema.schema as any)?.enum,
      };

      if (model.dependencies) {
        dependencies.push(...model.dependencies);
      }
      fields.push(field);
    }

    const model: TypeGenModel<{ name: string }> = {
      name,
      tType: TypeGenTypes.methodParam,
      schema: { name },
      location: null,
      dependencies,
      fields,
    };

    return this.assertRef(model.schema as any, model as TypeGenModel, name)?.ref;
  }
}

const usage = `usage: typegen <input_api_json | parsed_typegen> [output_path | --from-typegen-json]

When --from-typegen-json is provided, the already parsed is loaded from file, and will emit model events and no output is written.

eg:
  typegen api.json
  typegen api.json typegen.json
  typegen typegen.json --from-typegen-json
`;

const main = async () => {
  if (process.argv.length < 3) {
    console.error(`requires a file as argument\n${usage}`);
    process.exit(1);
  }

  const positional: string[] = [];
  let inputFileType: 'openapi' | 'typegen' = 'openapi';

  for (const arg of process.argv.slice(2)) {
    if (arg === '--from-typegen-json') {
      inputFileType = 'typegen';
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 2) {
    console.error(`too many arguments arguments\n${usage}`);
    process.exit(1);
  }

  const file = join(process.cwd(), positional[0]);
  if (
    !(await access(file)
      .then(() => true)
      .catch(() => false))
  ) {
    console.error(`File not found: ${positional[0]}`);
    process.exit(1);
  }

  const input = require(file);
  const output = positional[1] ? createWriteStream(positional[1]) : process.stdout;

  const tg = new TypeGen();

  if (inputFileType === 'typegen') {
    await tg.loadParsed(input);
  } else {
    await tg.parseSchema(input, file);
    output.write(JSON.stringify(tg.parsedSchemas));
  }
};

if (require.main === module) {
  main().catch(console.error);
} else {
  global.TypeGen = TypeGen;
}
