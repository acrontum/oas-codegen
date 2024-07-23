import { OpenAPIV3 } from 'openapi-types';
import { ModelTypes, TypeGenTypes, methods, schemaTypeHints, validators } from './lib';

export type ValueOf<T> = T[keyof T];
export type SchemaComponent = ValueOf<ValueOf<OpenAPIV3.ComponentsObject>>;
export type NonRefSchema =
  | OpenAPIV3.SchemaObject
  | OpenAPIV3.ResponseObject
  | OpenAPIV3.ParameterObject
  | OpenAPIV3.ExampleObject
  | OpenAPIV3.RequestBodyObject
  | OpenAPIV3.HeaderObject
  | OpenAPIV3.SecuritySchemeObject
  | OpenAPIV3.LinkObject
  | OpenAPIV3.CallbackObject;
export type TypeGenType = (typeof TypeGenTypes)[keyof typeof TypeGenTypes];
export type ModelType = (typeof ModelTypes)[keyof typeof ModelTypes];
export type TypeGenRef = { tType: typeof TypeGenTypes.remoteRef | typeof TypeGenTypes.ref; name: string };
export type Validations = Partial<Record<keyof typeof validators, any>>;
export type Method = keyof typeof methods;
export type SchemaTypeHint = (typeof schemaTypeHints)[keyof typeof schemaTypeHints];
export type TypeGenTypeDep = TypeGenModel<SchemaComponent> | TypeGenRef;
export type TypeGenSchemaRefString = string;

export interface TypeGenModel<T = SchemaComponent> {
  name: string;
  tType: TypeGenType;
  schema: T;
  location: string;
  type?: ModelType | string;
  enum?: string[];
  description?: string;
  validations?: Validations;
  dependencies?: TypeGenTypeDep[];
  fields?: TypeGenTypeField[];
  array?: boolean;
  extras?: Record<string, any>;
  anyOf?: (TypeGenModel | TypeGenRef)[];
  allOf?: (TypeGenModel | TypeGenRef)[];
  oneOf?: (TypeGenModel | TypeGenRef)[];
}

export interface TypeGenTypeField {
  name: string;
  tType: TypeGenType;
  type: ModelType | TypeGenSchemaRefString;
  validations: Validations;
  schema?: unknown;
  location?: string;
  description?: string;
  subtype?: string;
  enum?: string[];
  array?: boolean;
  extras?: Record<string, any>;
  default?: any;
}

export interface TypeGenPathItem {
  name: string;
  tType: typeof TypeGenTypes.path;
  schema: OpenAPIV3.PathItemObject;
  description?: string;
  methods?: (Omit<TypeGenMethod, 'path'> & { path: string })[];
}

export interface TypeGenMethod {
  name: string;
  method: Method;
  tType: typeof TypeGenTypes.method;
  schema: OpenAPIV3.OperationObject;
  path: TypeGenPathItem;
  pathParams: TypeGenRef[];
  headerParams: TypeGenRef[];
  queryParams: TypeGenRef[];
  responses: TypeGenResponse[];
  pathObject?: TypeGenRef;
  headerObject?: TypeGenRef;
  queryObject?: TypeGenRef;
  requestBodies?: TypeGenBody[];
  description?: string;
  tags?: string[];
  security?: TypeGenModel[];
}

export interface TypeGenResponse {
  name: string;
  status: number;
  payload: TypeGenRef;
  headers?: Record<string, TypeGenRef>;
  type: TypeGenSchemaRefString;
  tType?: typeof TypeGenTypes.response | typeof TypeGenTypes.remoteRef;
  array?: boolean;
  description?: string;
  contentType?: string;
}

export interface TypeGenBody {
  name: string;
  tType: typeof TypeGenTypes.requestBody;
  payload: TypeGenRef;
  type: TypeGenSchemaRefString;
  description?: string;
  contentType?: string;
  validators?: { required: true };
}

export type SchemaTypeData<T extends Record<string, unknown> = {}> = {
  name?: string;
  deps?: TypeGenTypeDep[];
  required?: Record<string, boolean>;
} & T;
