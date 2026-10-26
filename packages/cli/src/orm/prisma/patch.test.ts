import {
	applyDdlToSchema,
	type DDLPlan,
	type DDLStatement,
	type Field,
	lowerDDL,
	parse,
	type SchemaModel,
	tokenize
} from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import {
	PrismaPatchError,
	type PrismaPatchNames,
	patchPrismaSchema
} from "./patch";

const NOTE_BLOCK = `model Note {
  id        Int    @id @default(autoincrement())
  agency_id String @db.Uuid
  body      String // texte libre

  Agency Agency @relation(fields: [agency_id], references: [id], onDelete: Cascade)

  @@index([agency_id], name: "note_agency_idx")
  @@map("note")
}`;

const PG = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Agences et leurs notes.
model Agency {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name       String   @db.VarChar(255)
  created_at DateTime @default(now()) @db.Timestamptz(6)
  plan       Tier     @default(free)

  Note Note[]

  @@index([name])
  @@map("agency")
}

${NOTE_BLOCK}

enum Tier {
  free
  pro
}
`;

const field = (
	name: string,
	type: Field["type"],
	extra: Partial<Field> = {}
): Field => ({ name, type, nullable: false, source: "declared", ...extra });

const PG_DB: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "agency",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				field("id", "uuid", { hasDefault: true }),
				field("name", "string"),
				field("created_at", "date", { hasDefault: true }),
				field("plan", "enum", {
					enumTypeName: "Tier",
					enumValues: ["free", "pro"],
					hasDefault: true
				})
			],
			indexes: [{ name: "agency_name_idx", columns: ["name"], unique: false }]
		},
		{
			name: "note",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				field("id", "int", { hasDefault: true }),
				field("agency_id", "uuid"),
				field("body", "string")
			],
			indexes: [
				{ name: "note_agency_idx", columns: ["agency_id"], unique: false }
			]
		}
	],
	relations: [],
	enums: [{ name: "Tier", members: ["free", "pro"], source: "declared" }],
	refs: [
		{
			name: "note_agency_id_fkey",
			fromCollection: "note",
			fromColumn: "agency_id",
			toCollection: "agency",
			toColumn: "id",
			onDelete: "cascade",
			onUpdate: "cascade",
			source: "declared"
		}
	]
};

/** Champs en camelCase avec `@map`, relations en camelCase. */
const CAMEL = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id
  firstName String   @map("first_name")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  posts Post[]

  @@map("users")
}

model Post {
  id       Int  @id
  authorId Int  @map("author_id")
  author   User @relation(fields: [authorId], references: [id])

  @@map("posts")
}
`;

const CAMEL_DB: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				field("id", "int"),
				field("first_name", "string"),
				field("created_at", "date", { hasDefault: true })
			]
		},
		{
			name: "posts",
			source: "declared",
			primaryKey: ["id"],
			fields: [field("id", "int"), field("author_id", "int")]
		}
	],
	relations: [],
	refs: [
		{
			name: "posts_author_id_fkey",
			fromCollection: "posts",
			fromColumn: "author_id",
			toCollection: "users",
			toColumn: "id",
			onDelete: "restrict",
			onUpdate: "cascade",
			source: "declared"
		}
	]
};

const MSSQL = `datasource db {
  provider = "sqlserver"
  url      = env("DATABASE_URL")
}

model Agency {
  id   Int    @id
  name String @db.NVarChar(Max)

  Note Note[]

  @@map("agency")
}

model Note {
  id        Int @id
  agency_id Int

  Agency Agency @relation(fields: [agency_id], references: [id])

  @@map("note")
}
`;

const MSSQL_DB: SchemaModel = {
	engine: "mssql",
	collections: [
		{
			name: "agency",
			source: "declared",
			primaryKey: ["id"],
			fields: [field("id", "int"), field("name", "string")]
		},
		{
			name: "note",
			source: "declared",
			primaryKey: ["id"],
			fields: [field("id", "int"), field("agency_id", "int")]
		}
	],
	relations: [],
	refs: [
		{
			name: "note_agency_id_fkey",
			fromCollection: "note",
			fromColumn: "agency_id",
			toCollection: "agency",
			toColumn: "id",
			onDelete: "restrict",
			onUpdate: "cascade",
			source: "declared"
		}
	]
};

interface Start {
	readonly text: string;
	readonly db: SchemaModel;
}

/** DDL appliqués l'un après l'autre : modèle patché, base simulée. */
function run(
	sources: readonly (string | DDLPlan)[],
	start: Start = { text: PG, db: PG_DB },
	names?: PrismaPatchNames
): { text: string; names: PrismaPatchNames } {
	let { text, db } = start;
	let last: PrismaPatchNames = {};
	for (const src of sources) {
		const plan =
			typeof src === "string"
				? lowerDDL(parse(tokenize(src)) as DDLStatement, db, {
						ormProfile: "prisma",
						concurrentIndex: false
					})
				: src;
		const result = patchPrismaSchema(text, plan, {
			schema: db,
			...(names !== undefined ? { names } : {})
		});
		text = result.text;
		last = result.names;
		db = applyDdlToSchema(db, plan);
	}
	return { text, names: last };
}

const SPACES_RE = /\s+/g;

/** Lignes d'un bloc, espaces réduits ; `undefined` sans le bloc. */
function block(text: string, header: string): string[] | undefined {
	const lines = text.split("\n");
	const start = lines.indexOf(`${header} {`);
	if (start === -1) return undefined;
	const end = lines.findIndex((l, i) => i > start && l.trim() === "}");
	return lines
		.slice(start, end + 1)
		.map((l) => l.trim().replace(SPACES_RE, " "));
}

const AGENCY_SCALARS = [
	"model Agency {",
	'id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid',
	"name String @db.VarChar(255)",
	"created_at DateTime @default(now()) @db.Timestamptz(6)",
	"plan Tier @default(free)",
	""
];

const CREATE_TAG =
	"create table agency_tag { id: uuid default uuid(), owner_agency_id: uuid ref agency.id on delete cascade, name: string unique, created_at: timestamp default now(), primary key (id) }";

describe("patchPrismaSchema — tables", () => {
	it("create table : modèle PascalCase + @@map, types natifs, défauts, relation et champ retour", () => {
		const out = run([CREATE_TAG]);
		expect(block(out.text, "model AgencyTag")).toEqual([
			"model AgencyTag {",
			'id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid',
			"owner_agency_id String @db.Uuid",
			"name String @unique",
			"created_at DateTime @default(now()) @db.Timestamptz(6)",
			"",
			"Agency Agency @relation(fields: [owner_agency_id], references: [id], onDelete: Cascade)",
			"",
			'@@map("agency_tag")',
			"}"
		]);
		expect(block(out.text, "model Agency")).toEqual([
			...AGENCY_SCALARS,
			"Note Note[]",
			"AgencyTag AgencyTag[]",
			"",
			"@@index([name])",
			'@@map("agency")',
			"}"
		]);
		expect(out.names).toEqual({
			model: "AgencyTag",
			relations: {
				"agency_tag.owner_agency_id": { field: "Agency", back: "AgencyTag" }
			}
		});
		// Après le dernier modèle, avant les enums ; le reste à l'identique.
		const at = out.text.indexOf("model AgencyTag");
		expect(at).toBeGreaterThan(out.text.indexOf("model Note"));
		expect(at).toBeLessThan(out.text.indexOf("enum Tier"));
		expect(out.text).toContain(`\n${NOTE_BLOCK}\n`);
		expect(out.text).toContain("// Agences et leurs notes.\nmodel Agency {");
	});

	it("2ᵉ relation entre les mêmes modèles : les deux nommées, des deux côtés", () => {
		const out = run([
			CREATE_TAG,
			"add column backup_agency_id uuid nullable ref agency.id on delete set null into agency_tag"
		]);
		expect(block(out.text, "model AgencyTag")).toEqual([
			"model AgencyTag {",
			'id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid',
			"owner_agency_id String @db.Uuid",
			"name String @unique",
			"created_at DateTime @default(now()) @db.Timestamptz(6)",
			"backup_agency_id String? @db.Uuid",
			"",
			'Agency Agency @relation("AgencyTagOwner", fields: [owner_agency_id], references: [id], onDelete: Cascade)',
			'BackupAgency Agency? @relation("AgencyTagBackup", fields: [backup_agency_id], references: [id])',
			"",
			'@@map("agency_tag")',
			"}"
		]);
		expect(block(out.text, "model Agency")?.slice(6, 9)).toEqual([
			"Note Note[]",
			'AgencyTag AgencyTag[] @relation("AgencyTagOwner")',
			'BackupAgencyTags AgencyTag[] @relation("AgencyTagBackup")'
		]);
		expect(out.names).toEqual({
			relations: {
				"agency_tag.owner_agency_id": { name: "AgencyTagOwner" },
				"agency_tag.backup_agency_id": {
					field: "BackupAgency",
					back: "BackupAgencyTags",
					name: "AgencyTagBackup"
				}
			}
		});
	});

	it("noms fournis par l'aperçu ; un nom de modèle pris est refusé", () => {
		const out = run([CREATE_TAG], undefined, {
			model: "Tag",
			relations: {
				"agency_tag.owner_agency_id": { field: "owner", back: "tags" }
			}
		});
		expect(block(out.text, "model Tag")?.[6]).toBe(
			"owner Agency @relation(fields: [owner_agency_id], references: [id], onDelete: Cascade)"
		);
		expect(block(out.text, "model Agency")).toContain("tags Tag[]");
		expect(() => run([CREATE_TAG], undefined, { model: "Agency" })).toThrow(
			PrismaPatchError
		);
	});

	it("clé composite, table sans clé, relation d'un modèle vers lui-même", () => {
		const out = run([
			"create table pair { a: int, b: int, primary key (a, b) }",
			"create table log { msg: string }",
			"create table node { id: int, parent_id: int nullable ref self.id, primary key (id) }"
		]);
		expect(block(out.text, "model Pair")?.slice(-4)).toEqual([
			"",
			"@@id([a, b])",
			'@@map("pair")',
			"}"
		]);
		expect(block(out.text, "model Log")?.slice(-3)).toEqual([
			'@@map("log")',
			"@@ignore",
			"}"
		]);
		expect(block(out.text, "model Node")).toEqual([
			"model Node {",
			"id Int @id",
			"parent_id Int?",
			"",
			'ParentNode Node? @relation("NodeParent", fields: [parent_id], references: [id], onDelete: Restrict)',
			'ParentNodes Node[] @relation("NodeParent")',
			"",
			'@@map("node")',
			"}"
		]);
	});

	it("drop table : bloc et champs qui le citent retirés", () => {
		const out = run(["drop table note"]);
		expect(block(out.text, "model Note")).toBeUndefined();
		expect(block(out.text, "model Agency")).toEqual([
			...AGENCY_SCALARS,
			"@@index([name])",
			'@@map("agency")',
			"}"
		]);
		expect(out.text).toContain("\n}\n\nenum Tier {");
	});
});

describe("patchPrismaSchema — colonnes", () => {
	it("add column : après le dernier scalaire", () => {
		const out = run(['add column title string nullable default "" into note']);
		expect(block(out.text, "model Note")?.slice(1, 5)).toEqual([
			"id Int @id @default(autoincrement())",
			"agency_id String @db.Uuid",
			"body String // texte libre",
			'title String? @default("")'
		]);
	});

	it("drop column : FK, champ retour et index qui la citent retirés", () => {
		const out = run(["drop column agency_id from note"]);
		expect(block(out.text, "model Note")).toEqual([
			"model Note {",
			"id Int @id @default(autoincrement())",
			"body String // texte libre",
			"",
			'@@map("note")',
			"}"
		]);
		expect(block(out.text, "model Agency")).not.toContain("Note Note[]");
	});

	it("rename column : champ, listes d'index et de FK, références d'une autre table", () => {
		const out = run([
			"rename column note.agency_id to owner_id",
			"rename column agency.name to label",
			"rename column agency.id to uid"
		]);
		expect(block(out.text, "model Note")?.slice(2, 8)).toEqual([
			"owner_id String @db.Uuid",
			"body String // texte libre",
			"",
			"Agency Agency @relation(fields: [owner_id], references: [uid], onDelete: Cascade)",
			"",
			'@@index([owner_id], name: "note_agency_idx")'
		]);
		expect(block(out.text, "model Agency")).toContain("@@index([label])");
	});

	it("alter column : nullabilité de la FK (action réécrite), défaut, type", () => {
		const out = run([
			"alter column note.agency_id set nullable",
			'alter column note.body set default "vide"',
			"alter column agency.created_at drop default",
			"alter column agency.plan set type string"
		]);
		const note = block(out.text, "model Note");
		expect(note).toContain("agency_id String? @db.Uuid");
		expect(note).toContain('body String @default("vide") // texte libre');
		expect(note).toContain(
			"Agency Agency? @relation(fields: [agency_id], references: [id], onDelete: Cascade)"
		);
		const agency = block(out.text, "model Agency");
		expect(agency).toContain("created_at DateTime @db.Timestamptz(6)");
		expect(agency).toContain('plan String @default("free")');
		expect(
			block(run(["alter column note.body set type json"]).text, "model Note")
		).toContain("body Json // texte libre");
	});
});

describe("patchPrismaSchema — index et FK", () => {
	it("unicité d'une colonne sur le champ ; index et unicité composés en attribut de bloc", () => {
		const out = run([
			"add unique index (body) into note",
			"add index (agency_id, body) into note",
			"add unique index (agency_id, body) into note"
		]);
		const note = block(out.text, "model Note");
		expect(note).toContain("body String @unique // texte libre");
		expect(note?.slice(-6)).toEqual([
			"",
			'@@index([agency_id], name: "note_agency_idx")',
			"@@index([agency_id, body])",
			"@@unique([agency_id, body])",
			'@@map("note")',
			"}"
		]);
	});

	it("nom hors convention : `map:` ; drop index par nom en base, ancienne forme `name:` comprise", () => {
		const out = run([
			{
				op: "ddl",
				kind: "add-index",
				target: "note",
				fields: ["body"],
				name: "note_body_search",
				ifNotExists: false
			},
			"drop index note_agency_idx from note",
			"drop index agency_name_idx from agency"
		]);
		expect(block(out.text, "model Note")?.slice(-4)).toEqual([
			"",
			'@@index([body], map: "note_body_search")',
			'@@map("note")',
			"}"
		]);
		expect(block(out.text, "model Agency")).not.toContain("@@index([name])");
	});

	it("drop ref puis add ref : relation et champ retour retirés, puis reposés", () => {
		const dropped = run(["drop ref note_agency_id_fkey from note"]);
		expect(block(dropped.text, "model Note")).not.toContain(
			"Agency Agency @relation(fields: [agency_id], references: [id], onDelete: Cascade)"
		);
		expect(block(dropped.text, "model Agency")).not.toContain("Note Note[]");
		const back = run([
			"drop ref note_agency_id_fkey from note",
			"add ref (agency_id) references agency.id into note"
		]);
		expect(block(back.text, "model Note")).toEqual([
			"model Note {",
			"id Int @id @default(autoincrement())",
			"agency_id String @db.Uuid",
			"body String // texte libre",
			"",
			"Agency Agency @relation(fields: [agency_id], references: [id])",
			"",
			'@@index([agency_id], name: "note_agency_idx")',
			'@@map("note")',
			"}"
		]);
		expect(block(back.text, "model Agency")).toContain("Note Note[]");
	});
});

describe("patchPrismaSchema — enums", () => {
	it("create enum après les enums, valeur ajoutée, drop enum cascade avec ses colonnes", () => {
		const out = run([
			'create enum status { "draft", "live" }',
			'add enum member Tier "team"',
			"create table doc { id: int, state: status, primary key (id) }"
		]);
		expect(out.text.endsWith("enum status {\n  draft\n  live\n}\n")).toBe(true);
		expect(block(out.text, "enum Tier")).toEqual([
			"enum Tier {",
			"free",
			"pro",
			"team",
			"}"
		]);
		expect(block(out.text, "model Doc")?.[2]).toBe("state status");
		const dropped = run(["drop enum Tier cascade"]);
		expect(block(dropped.text, "enum Tier")).toBeUndefined();
		expect(block(dropped.text, "model Agency")).not.toContain(
			"plan Tier @default(free)"
		);
	});
});

describe("patchPrismaSchema — conventions camelCase", () => {
	const start = { text: CAMEL, db: CAMEL_DB };

	it("champ camelCase + @map ; champ de relation tiré de la colonne", () => {
		const out = run(
			[
				"add column last_name string nullable into users",
				"add column editor_id int nullable ref users.id into posts"
			],
			start
		);
		expect(block(out.text, "model User")).toEqual([
			"model User {",
			"id Int @id",
			'firstName String @map("first_name")',
			'createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)',
			'lastName String? @map("last_name")',
			"",
			'posts Post[] @relation("PostAuthor")',
			'editorPosts Post[] @relation("PostEditor")',
			"",
			'@@map("users")',
			"}"
		]);
		expect(block(out.text, "model Post")).toEqual([
			"model Post {",
			"id Int @id",
			'authorId Int @map("author_id")',
			'editorId Int? @map("editor_id")',
			'author User @relation("PostAuthor", fields: [authorId], references: [id])',
			'editor User? @relation("PostEditor", fields: [editorId], references: [id], onDelete: Restrict)',
			"",
			'@@map("posts")',
			"}"
		]);
	});

	it("rename : un champ conventionnel suit la colonne ; set type : la FK suit ; nullabilité : Restrict écrit", () => {
		const out = run(
			[
				"rename column users.first_name to given_name",
				"rename column posts.author_id to writer_id",
				"alter column posts.writer_id set nullable"
			],
			start
		);
		expect(block(out.text, "model User")).toContain(
			'givenName String @map("given_name")'
		);
		const typed = run(["alter column users.id set type bigint"], start);
		expect(block(typed.text, "model User")?.[1]).toBe("id BigInt @id");
		expect(block(typed.text, "model Post")?.[2]).toBe(
			'authorId BigInt @map("author_id")'
		);
		expect(block(out.text, "model Post")?.slice(2, 4)).toEqual([
			'writerId Int? @map("writer_id")',
			"author User? @relation(fields: [writerId], references: [id], onDelete: Restrict)"
		]);
	});
});

describe("patchPrismaSchema — SQL Server", () => {
	const start = { text: MSSQL, db: MSSQL_DB };

	it("enum : colonne en texte, table des enums de SQLNest déclarée une fois", () => {
		const out = run(
			[
				'create enum status { "draft", "live" }',
				'create enum kind { "a" }',
				"add column state status nullable into agency"
			],
			start
		);
		expect(block(out.text, "model Agency")?.[3]).toBe(
			"state String? @db.NVarChar(450)"
		);
		expect(out.text.match(/model SnqlEnums/g)).toHaveLength(1);
		expect(out.text).toContain(
			"\n// Enums de SQLNest : SQL Server n'a pas de type enum.\nmodel SnqlEnums {"
		);
		expect(block(out.text, "model SnqlEnums")).toEqual([
			"model SnqlEnums {",
			"name String @id @db.NVarChar(128)",
			"members String @db.NVarChar(Max)",
			"",
			'@@map("_snql_enums")',
			"@@ignore",
			"}"
		]);
		expect(out.text).not.toContain("enum status");
	});

	it("index : texte (max) rétréci en nvarchar(450) ; défaut de date, set type avec les colonnes de ses FK", () => {
		const out = run(
			[
				"add index (name) into agency",
				"add column created_at timestamp default now() into agency",
				"alter column agency.id set type bigint"
			],
			start
		);
		const agency = block(out.text, "model Agency");
		expect(agency?.slice(1, 4)).toEqual([
			"id BigInt @id",
			"name String @db.NVarChar(450)",
			'created_at DateTime @default(dbgenerated("sysdatetimeoffset()")) @db.DateTimeOffset'
		]);
		expect(agency).toContain("@@index([name])");
		expect(block(out.text, "model Note")?.[2]).toBe("agency_id BigInt");
	});

	it("FK : la colonne prend le type du champ référencé ; set type : un seul type natif pour toute la chaîne", () => {
		const out = run(
			[
				"add column code string unique into agency",
				"create table tag { id: int, agency_code: string nullable ref agency.code, parent_code: string nullable, code: string unique, primary key (id) }",
				"add ref (parent_code) references tag.code into tag",
				"add column backup_code string nullable ref agency.code into tag"
			],
			start
		);
		expect(block(out.text, "model Agency")?.[3]).toBe(
			"code String @unique @db.NVarChar(450)"
		);
		expect(block(out.text, "model Tag")?.slice(1, 6)).toEqual([
			"id Int @id",
			"agency_code String? @db.NVarChar(450)",
			"parent_code String? @db.NVarChar(450)",
			"code String @unique @db.NVarChar(450)",
			"backup_code String? @db.NVarChar(450)"
		]);
		// Clé non indexée d'un côté, indexée de l'autre : nvarchar(450) partout.
		const typed = run(
			[
				"add column code string unique into agency",
				"create table tag { id: int, agency_code: string nullable ref agency.code, primary key (id) }",
				"alter column tag.agency_code set type string"
			],
			start
		);
		expect(block(typed.text, "model Tag")?.[2]).toBe(
			"agency_code String? @db.NVarChar(450)"
		);
		expect(block(typed.text, "model Agency")?.[3]).toBe(
			"code String @unique @db.NVarChar(450)"
		);
	});

	it("add ref vers un BigInt : la colonne et celles qui la référencent passent en BigInt ; String sans @db gardé tel quel", () => {
		const withLegacy = {
			text: MSSQL.replace(
				"model Note {",
				'model Legacy {\n  id   BigInt @id\n  code String @unique\n\n  @@map("legacy")\n}\n\nmodel Note {'
			),
			db: {
				...MSSQL_DB,
				collections: [
					...MSSQL_DB.collections,
					{
						name: "legacy",
						source: "declared" as const,
						primaryKey: ["id"],
						fields: [field("id", "bigint"), field("code", "string")]
					}
				]
			}
		};
		const out = run(
			[
				"add ref (id) references legacy.id into agency",
				"create table tag { id: int, legacy_code: string nullable ref legacy.code, primary key (id) }"
			],
			withLegacy
		);
		expect(block(out.text, "model Agency")?.[1]).toBe("id BigInt @id");
		// note.agency_id référence agency.id : la chaîne suit.
		expect(block(out.text, "model Note")?.[2]).toBe("agency_id BigInt");
		// legacy.code : nvarchar(1000) de Prisma, sans @db ; la FK aussi.
		expect(block(out.text, "model Tag")?.[2]).toBe("legacy_code String?");
	});
});

describe("patchPrismaSchema — MongoDB (ADR-036 D6, ADR-037 D3 bis)", () => {
	const MONGO = `datasource db {
  provider = "mongodb"
  url      = env("DATABASE_URL")
}

model Owner {
  id   String @id @default(auto()) @map("_id") @db.ObjectId
  name String

  @@map("owner")
}
`;
	const MONGO_DB: SchemaModel = {
		engine: "mongodb",
		collections: [
			{
				name: "owner",
				source: "inferred",
				primaryKey: ["_id"],
				fields: [
					field("_id", "string", { source: "inferred", storedAs: "objectId" }),
					field("name", "string", { source: "inferred" })
				]
			}
		],
		relations: []
	};
	const start = { text: MONGO, db: MONGO_DB };

	it("create table : clé `_id` en uuid texte, decimal en String, FK vers une clé ObjectId en @db.ObjectId", () => {
		const out = run(
			[
				"create table pet { id: uuid default uuid(), owner_id: string ref owner._id, price: decimal, born: date nullable, primary key (id) }",
				"add column fee decimal default 1.5 into pet",
				"add index (price) into pet"
			],
			start
		);
		expect(block(out.text, "model Pet")).toEqual([
			"model Pet {",
			'id String @id @default(uuid()) @map("_id")',
			"owner_id String @db.ObjectId",
			"price String",
			"born DateTime?",
			'fee String @default("1.5")',
			"",
			"Owner Owner @relation(fields: [owner_id], references: [id])",
			"",
			"@@index([price])",
			'@@map("pet")',
			"}"
		]);
		expect(block(out.text, "model Owner")).toContain("Pet Pet[]");
	});

	it("create table sans clé : Prisma attend l'ObjectId que Mongo pose", () => {
		const out = run(["create table tag { label: string }"], start);
		expect(block(out.text, "model Tag")).toEqual([
			"model Tag {",
			'id String @id @default(auto()) @map("_id") @db.ObjectId',
			"label String",
			"",
			'@@map("tag")',
			"}"
		]);
	});
});

describe("patchPrismaSchema — FK compensée sous SQL Server", () => {
	it("2ᵉ chemin de cascade : la relation décrit la base (NoAction), le commentaire dit l'action", () => {
		const out = run(
			[
				"add column backup_agency_id int nullable ref agency.id on delete set null into note"
			],
			{ text: MSSQL, db: MSSQL_DB }
		);
		expect(block(out.text, "model Note")).toContain(
			'BackupAgency Agency? @relation("NoteBackup", fields: [backup_agency_id], references: [id], onDelete: NoAction, onUpdate: NoAction) // SQLNest : on delete set null par trigger'
		);
	});
});

describe("patchPrismaSchema — cohérence", () => {
	it("fournisseur du fichier ≠ moteur de la connexion : refusé", () => {
		const plan = lowerDDL(
			parse(tokenize("drop table note")) as DDLStatement,
			MSSQL_DB
		);
		expect(() => patchPrismaSchema(PG, plan, { schema: MSSQL_DB })).toThrow(
			/décrit une base « postgresql », la connexion est mssql/
		);
	});

	it("table sans modèle : erreur nommée", () => {
		const plan = lowerDDL(
			parse(tokenize("add column x int nullable into note")) as DDLStatement,
			PG_DB
		);
		expect(() =>
			patchPrismaSchema(PG.replace(NOTE_BLOCK, ""), plan, { schema: PG_DB })
		).toThrow(/pas de modèle pour la table « note »/);
	});
});
