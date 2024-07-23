export const capitalize = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

// https://github.com/typeorm/typeorm/blob/master/src/util/StringUtils.ts
export const pascalCase = (str: string): string => camelCase(str, true);

export const camelCase = (str: string, firstCapital: boolean = false): string => {
  if (firstCapital) {
    str = ` ${str}`;
  }

  return str.replace(/^([A-Z])|[\s-_](\w)/g, (match, p1, p2) => p2?.toUpperCase() || p1.toLowerCase());
};

export const dashCase = (str: string): string => {
  return str
    .replace(/([A-Z])([A-Z])([a-z])/g, '$1-$2$3')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
};
