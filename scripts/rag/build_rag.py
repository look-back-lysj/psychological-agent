# -*- coding: utf-8 -*-
"""
守岸人 · 心理学 RAG 构建脚本
用途：把心理学权威资料 + 风格语料库索引进 Chroma 向量库
     用于构建时校验（产出 docs/psychology-basis.md）和答辩演示
不用于运行时检索（不影响流式生成延迟）

数据源：
  1. data/style-corpus.json —— 54+ 条风格语料（含心理学技术标注）
  2. _tmp/research/02-psychology-and-shorekeeper.md —— MI/Ivey 权威资料
  3. _tmp/research/_raw/mi_glossary.txt —— MI 官方术语表全文

用法：
  python scripts/rag/build_rag.py          # 建库
  python scripts/rag/build_rag.py --query "复杂反映怎么用"  # 建库+测试检索
"""

import json, os, sys, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DB_DIR = ROOT / "data" / "chroma_db"
COLLECTION_NAME = "psych_companion"

os.environ.setdefault("HF_HOME", r"D:\hf-models")

def load_style_corpus():
    """加载风格语料库，每条作为一个文档"""
    path = ROOT / "data" / "style-corpus.json"
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # 跳过 _meta 字段
    items = [x for x in data if isinstance(x, dict) and "id" in x]
    docs = []
    for item in items:
        text = f"场景：{item.get('scene','')}\n对方说：{item.get('user_says','')}\n守岸人说：{item.get('shorekeeper_says','')}\n技术：{item.get('psych_technique','')}"
        docs.append({
            "id": item["id"],
            "text": text,
            "metadata": {
                "source": item.get("source", ""),
                "technique": item.get("psych_technique", ""),
                "scene": item.get("scene", ""),
                "type": "style_corpus"
            }
        })
    return docs

def load_mi_glossary():
    """加载 MI 术语表，按术语条目切分"""
    path = ROOT / "_tmp" / "research" / "_raw" / "mi_glossary.txt"
    if not path.exists():
        print(f"  ⚠️ MI 术语表不存在: {path}")
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    # 按双换行或术语模式切分（术语名—定义）
    entries = []
    current_term = None
    current_text = []
    for line in text.split("\n"):
        # 检测术语行（通常以 — 或 – 分隔术语名和定义）
        if "—" in line and len(line) > 20 and not line.startswith(" "):
            if current_term and current_text:
                entries.append({"term": current_term, "text": "\n".join(current_text)})
            parts = line.split("—", 1)
            current_term = parts[0].strip()
            current_text = [line]
        elif current_term:
            current_text.append(line)
    if current_term and current_text:
        entries.append({"term": current_term, "text": "\n".join(current_text)})
    
    docs = []
    for i, entry in enumerate(entries):
        docs.append({
            "id": f"MI-G-{i+1:03d}",
            "text": entry["text"][:2000],  # 截断过长条目
            "metadata": {
                "source": "MI-G Glossary (Miller & Rollnick 2013)",
                "technique": entry["term"],
                "type": "mi_glossary"
            }
        })
    return docs

def load_research_report():
    """加载心理学调研报告，按章节切分"""
    path = ROOT / "_tmp" / "research" / "02-psychology-and-shorekeeper.md"
    if not path.exists():
        print(f"  ⚠️ 调研报告不存在: {path}")
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    # 按 ### 标题切分
    sections = []
    current_title = "前言"
    current_lines = []
    for line in text.split("\n"):
        if line.startswith("### "):
            if current_lines:
                sections.append({"title": current_title, "text": "\n".join(current_lines)})
            current_title = line.strip("# ").strip()
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_lines:
        sections.append({"title": current_title, "text": "\n".join(current_lines)})
    
    docs = []
    for i, sec in enumerate(sections):
        if len(sec["text"]) < 50:  # 跳过太短的分节
            continue
        docs.append({
            "id": f"R02-{i+1:03d}",
            "text": sec["text"][:3000],
            "metadata": {
                "source": "02-psychology-and-shorekeeper.md",
                "technique": sec["title"],
                "type": "research_report"
            }
        })
    return docs

def build_db(docs):
    """建 Chroma 向量库"""
    import chromadb
    from chromadb.utils import embedding_functions
    
    print(f"\n📦 建库：{len(docs)} 个文档 → {DB_DIR}")
    
    client = chromadb.PersistentClient(path=str(DB_DIR))
    
    # 用 BGE-small-zh 做 embedding（约 100MB，放 D 盘）
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="BAAI/bge-small-zh-v1.5",
        device="cpu"
    )
    
    # 删旧建新
    try:
        client.delete_collection(COLLECTION_NAME)
    except:
        pass
    
    collection = client.create_collection(
        name=COLLECTION_NAME,
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"}
    )
    
    # 批量插入
    batch_size = 32
    for i in range(0, len(docs), batch_size):
        batch = docs[i:i+batch_size]
        collection.add(
            ids=[d["id"] for d in batch],
            documents=[d["text"] for d in batch],
            metadatas=[d["metadata"] for d in batch]
        )
        print(f"  已索引 {min(i+batch_size, len(docs))}/{len(docs)}")
    
    print(f"✅ 建库完成，共 {collection.count()} 个文档")
    return collection

def query_db(collection, query_text, n_results=5):
    """测试检索"""
    results = collection.query(
        query_texts=[query_text],
        n_results=n_results
    )
    print(f"\n🔍 查询：「{query_text}」")
    for i, (doc_id, doc, meta, dist) in enumerate(zip(
        results["ids"][0], results["documents"][0],
        results["metadatas"][0], results["distances"][0]
    )):
        print(f"\n  [{i+1}] {doc_id} (距离: {dist:.4f})")
        print(f"      技术: {meta.get('technique','')}")
        print(f"      来源: {meta.get('source','')}")
        print(f"      内容: {doc[:150]}...")

def main():
    print("=" * 50)
    print("守岸人 · 心理学 RAG 构建")
    print("=" * 50)
    
    # 加载数据源
    print("\n📂 加载数据源...")
    corpus = load_style_corpus()
    print(f"  风格语料: {len(corpus)} 条")
    
    glossary = load_mi_glossary()
    print(f"  MI 术语: {len(glossary)} 条")
    
    report = load_research_report()
    print(f"  调研报告: {len(report)} 节")
    
    all_docs = corpus + glossary + report
    print(f"  合计: {len(all_docs)} 个文档")
    
    # 建库
    collection = build_db(all_docs)
    
    # 测试检索
    if "--query" in sys.argv:
        idx = sys.argv.index("--query")
        if idx + 1 < len(sys.argv):
            query_db(collection, sys.argv[idx + 1])
    else:
        # 默认测试几个查询
        query_db(collection, "复杂反映怎么用")
        query_db(collection, "对方说不想活了怎么办")
        query_db(collection, "summarizing 总结技术")

if __name__ == "__main__":
    main()