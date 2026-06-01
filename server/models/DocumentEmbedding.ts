import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import Document from "./Document";
import Team from "./Team";
import IdModel from "./base/IdModel";
import Fix from "./decorators/Fix";

@Table({ tableName: "document_embeddings", modelName: "documentEmbedding" })
@Fix
class DocumentEmbedding extends IdModel<
  InferAttributes<DocumentEmbedding>,
  Partial<InferCreationAttributes<DocumentEmbedding>>
> {
  /** Embedding model id that produced the stored vector (e.g. text-embedding-3-small). */
  @Column(DataType.STRING)
  model: string;

  // associations

  @BelongsTo(() => Document, "documentId")
  document: Document;

  @ForeignKey(() => Document)
  @Column(DataType.UUID)
  documentId: string;

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;
}

export default DocumentEmbedding;
