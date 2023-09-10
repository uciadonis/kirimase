import {
  DBField,
  DBProvider,
  DBType,
  DrizzleColumnType,
  ORMType,
} from "../../../../../types.js";
import { readConfigFile } from "../../../../../utils.js";
import { Schema, TypeMap } from "../../../types.js";
import {
  addToPrismaModel,
  addToPrismaSchema,
  formatTableName,
  getReferenceFieldType,
  toCamelCase,
} from "../../../utils.js";
import { createOrmMappings } from "../utils.js";
import { createZodSchemas } from "./generators.js";

const getUsedTypes = (fields: DBField[], mappings: TypeMap) => {
  return fields
    .map((field) => {
      const mappingFunction = mappings.typeMappings[field.type];
      // Assuming 'field.name' contains the appropriate value for the 'name' parameter
      return mappingFunction({ name: field.name }).split("(")[0];
    })
    .concat(
      mappings.typeMappings["id"]({ name: "id" }).split("(")[0]
    ) as DrizzleColumnType[]; // Assuming number (int) is always used for the 'id' field
};

const getReferenceImports = (fields: DBField[]) => {
  const referenceFields = fields.filter((field) => field.type === "references");
  return referenceFields.map(
    (field) =>
      `import { ${toCamelCase(field.references)} } from "./${toCamelCase(
        field.references
      )}"`
  );
};

const getUniqueTypes = (
  usedTypes: string[],
  belongsToUser: boolean,
  dbType: DBType
) => {
  return Array.from(
    new Set(
      usedTypes.concat(
        belongsToUser ? [getReferenceFieldType("string")[dbType]] : []
      )
    )
  );
};

const generateImportStatement = (
  orm: ORMType,
  schema: Schema,
  mappings: TypeMap,
  dbType?: DBType,
  provider?: DBProvider
) => {
  const { fields, belongsToUser, tableName } = schema;
  const { tableNameCamelCase, tableNameCapitalised, tableNameSingular } =
    formatTableName(tableName);
  if (orm === "drizzle") {
    const usedTypes = getUsedTypes(fields, mappings);
    const referenceImports = getReferenceImports(fields);

    const uniqueTypes = getUniqueTypes(usedTypes, belongsToUser, dbType);
    return `import { ${uniqueTypes
      .join(", ")
      .concat(
        `, ${mappings.tableFunc}`
      )} } from "drizzle-orm/${dbType}-core";\nimport { createInsertSchema, createSelectSchema } from "drizzle-zod";\nimport { z } from "zod";\n${
      referenceImports.length > 0 ? referenceImports.join("\n") : ""
    }${
      belongsToUser && provider !== "planetscale"
        ? '\nimport { users } from "./auth";'
        : ""
    }
import { get${tableNameCapitalised} } from "@/lib/api/${tableNameCamelCase}/queries";`;
  }
  if (orm === "prisma")
    return `import { ${tableNameSingular}Schema } from "@/zodAutoGenSchemas";
import { z } from "zod";
import { get${tableNameCapitalised} } from "@/lib/api/${tableNameCamelCase}/queries";
`;
};

const generateFieldsForSchema = (fields: DBField[], mappings: TypeMap) => {
  return fields
    .map(
      (field) =>
        `  ${toCamelCase(field.name)}: ${mappings.typeMappings[field.type](
          field
        )}${field.notNull ? ".notNull()" : ""}`
    )
    .join(",\n");
};

const generateIndex = (schema: Schema) => {
  const { tableName, index } = schema;
  const { tableNameCamelCase } = formatTableName(tableName);
  return index
    ? `, (${tableNameCamelCase}) => {
  return {
    ${toCamelCase(
      index
    )}Index: uniqueIndex('${index}_idx').on(${tableNameCamelCase}.${toCamelCase(
        index
      )}),
  }
}`
    : "";
};

const addUserReferenceIfBelongsToUser = (schema: Schema, mappings: TypeMap) => {
  return schema.belongsToUser
    ? `,\n  userId: ${mappings.typeMappings["references"]({
        name: "user_id",
        references: "users",
        cascade: true,
        referenceIdType: "string",
      }).concat(".notNull()")},`
    : "";
};

const generateDrizzleSchema = (
  schema: Schema,
  mappings: TypeMap,
  provider: DBProvider,
  dbType: DBType,
  zodSchemas: string
) => {
  const { tableName, fields } = schema;
  const { tableNameCamelCase } = formatTableName(tableName);

  const importStatement = generateImportStatement(
    "drizzle",
    schema,
    mappings,
    dbType,
    provider
  );

  const userGeneratedFields = generateFieldsForSchema(fields, mappings);
  const indexFormatted = generateIndex(schema);

  const drizzleSchemaContent = `export const ${tableNameCamelCase} = ${
    mappings.tableFunc
  }('${tableName}', {
  id: ${mappings.typeMappings["id"]({ name: "id" })},
${userGeneratedFields}${addUserReferenceIfBelongsToUser(schema, mappings)}
}${indexFormatted});\n`;

  return `${importStatement}\n\n${drizzleSchemaContent}\n\n${zodSchemas}`;
};

const generatePrismaSchema = (
  schema: Schema,
  mappings: TypeMap,
  zodSchemas: string
) => {
  const { tableNameSingularCapitalised, tableNameCamelCase } = formatTableName(
    schema.tableName
  );
  const prismaSchemaContent = `model ${tableNameSingularCapitalised} {
    id    String @id @default(cuid())
  ${schema.fields
    .map((field) => mappings.typeMappings[field.type](field))
    .join("\n  ")}
}`;
  addToPrismaSchema(prismaSchemaContent, tableNameSingularCapitalised);
  const relations = schema.fields.filter(
    (field) => field.type.toLowerCase() === "references"
  );
  relations.forEach((relation) => {
    const { references } = relation;
    const { tableNameSingularCapitalised: singularCapitalised } =
      formatTableName(references);
    addToPrismaModel(
      singularCapitalised,
      `${tableNameCamelCase} ${tableNameSingularCapitalised}[]`
    );
  });
  const importStatement = generateImportStatement("prisma", schema, mappings);

  return `${importStatement}\n\n${zodSchemas}`;
};

export function generateModelContent(schema: Schema, dbType: DBType) {
  const { provider, orm } = readConfigFile();
  const mappings = createOrmMappings()[orm][dbType];
  const zodSchemas = createZodSchemas(schema, orm);

  if (orm === "drizzle") {
    return generateDrizzleSchema(
      schema,
      mappings,
      provider,
      dbType,
      zodSchemas
    );
  }
  if (orm === "prisma") {
    return generatePrismaSchema(schema, mappings, zodSchemas);
  }
}
