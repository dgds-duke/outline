"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `CREATE EXTENSION IF NOT EXISTS vector;`
    );
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "document_embeddings",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            defaultValue: Sequelize.UUIDV4,
          },
          documentId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "documents", key: "id" },
            onDelete: "CASCADE",
          },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
            onDelete: "CASCADE",
          },
          model: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE document_embeddings ADD COLUMN embedding vector(1536) NOT NULL;`,
        { transaction }
      );
      await queryInterface.addIndex(
        "document_embeddings",
        ["documentId", "model"],
        { unique: true, transaction }
      );
      await queryInterface.addIndex("document_embeddings", ["teamId"], {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE INDEX document_embeddings_hnsw_idx ON document_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=200);`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("document_embeddings", { transaction });
    });
  },
};
