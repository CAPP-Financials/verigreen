import os
from supabase import create_client, Client

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
else:
    supabase = None

async def _persist_feedback_to_supabase(correct_node_id: str, claim_embedding: list[float]):
    if not supabase:
        print("Supabase client not initialized. Skipping feedback persistence.")
        return
    try:
        response = supabase.from_('taxonomy_embeddings').insert({
            'node_id': correct_node_id,
            'embedding': claim_embedding
        }).execute()
        print(f"Persisted feedback to Supabase: {response.data}")
    except Exception as e:
        print(f"Error persisting feedback to Supabase: {e}")

async def _load_embeddings_from_supabase():
    if not supabase:
        print("Supabase client not initialized. Skipping embedding load.")
        return
    try:
        response = supabase.from_('taxonomy_embeddings').select('*').execute()
        # This is a simplified example. In a real scenario, you'd process these embeddings
        # and load them into the _node_embeddings in embedding_matcher.py
        print(f"Loaded embeddings from Supabase: {len(response.data)} records")
    except Exception as e:
        print(f"Error loading embeddings from Supabase: {e}")
