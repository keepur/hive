/**
 * Compare embedding model quality: Voyage (Atlas baseline) vs local models (Qdrant).
 * Runs the same queries against all backends and shows top-5 results side by side.
 */
import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";

const ATLAS_URI = process.env.MONGODB_ATLAS_URI!;
const VOYAGE_KEY = process.env.VOYAGEAI_API_KEY!;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

const QUERIES = [
  "milk oak",
  "Shinnoki milk oak",
  "manhattan oak",
  "customers interested in milk oak cabinets",
];

const LOCAL_MODELS = ["nomic-embed-text", "mxbai-embed-large", "bge-large"];

async function embedOllama(model: string, text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.embeddings[0];
}

async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${VOYAGE_KEY}` },
    body: JSON.stringify({ model: "voyage-4-lite", input: [text], input_type: "query" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function main() {
  // Connect
  const atlas = new MongoClient(ATLAS_URI);
  await atlas.connect();
  const db = atlas.db("hubspot");
  const qdrant = new QdrantClient({ url: QDRANT_URL });

  // Check dimensions
  console.log("Model dimensions:");
  for (const m of LOCAL_MODELS) {
    const vec = await embedOllama(m, "test");
    console.log(`  ${m}: ${vec.length}`);
  }
  const voyageVec = await embedVoyage("test");
  console.log(`  voyage-4-lite: ${voyageVec.length}`);
  console.log();

  for (const query of QUERIES) {
    console.log(`${"=".repeat(80)}`);
    console.log(`QUERY: "${query}"`);
    console.log(`${"=".repeat(80)}`);

    // Voyage + Atlas baseline
    console.log("\n--- voyage-4-lite (Atlas) ---");
    const voyageEmb = await embedVoyage(query);
    for (const colName of ["rag_contacts", "rag_deals", "rag_activities"]) {
      const results = await db.collection(colName).aggregate([
        { $vectorSearch: { index: "vector_index", path: "embedding", queryVector: voyageEmb, numCandidates: 50, limit: 3 } },
        { $project: { embeddingText: 1, score: { $meta: "vectorSearchScore" } } },
      ]).toArray();
      if (results.length > 0) {
        console.log(`  [${colName}]`);
        results.forEach((r, i) => console.log(`    ${i + 1}. [${r.score.toFixed(3)}] ${(r.embeddingText || "").slice(0, 150)}`));
      }
    }

    // Local models + Qdrant
    for (const model of LOCAL_MODELS) {
      console.log(`\n--- ${model} (Qdrant) ---`);
      // Need to re-embed with this model and search — but Qdrant has nomic embeddings.
      // For mxbai and bge, we need separate collections or search differently.
      // For now, only test nomic against Qdrant, and show raw embedding similarity for others.
      if (model === "nomic-embed-text") {
        const emb = await embedOllama(model, query);
        for (const colName of ["contacts", "deals", "activities"]) {
          const results = await qdrant.search(colName, {
            vector: emb,
            limit: 3,
            with_payload: true,
          });
          if (results.length > 0) {
            console.log(`  [${colName}]`);
            results.forEach((r, i) => console.log(`    ${i + 1}. [${r.score.toFixed(3)}] ${((r.payload as any)?.embeddingText || "").slice(0, 150)}`));
          }
        }
      } else {
        // For other models, embed and search a small in-memory set from Atlas to compare
        const emb = await embedOllama(model, query);
        console.log(`  (dims: ${emb.length} — needs separate Qdrant collection to search, skipping Qdrant)`);
        console.log(`  Embedding latency test...`);
        const start = Date.now();
        for (let i = 0; i < 5; i++) await embedOllama(model, query);
        console.log(`  5 embeddings in ${Date.now() - start}ms (avg ${((Date.now() - start) / 5).toFixed(0)}ms)`);
      }
    }
    console.log();
  }

  await atlas.close();
}

main().catch(console.error);
