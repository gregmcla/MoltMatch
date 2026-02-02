# Debug Failed Post

When a post fails to publish, investigate:

1. Check recent logs for errors:
```bash
tail -100 logs/skilllinker.log | grep -i error
```

2. Common issues:
   - JSON parsing failures (unescaped newlines in LLM output)
   - API authentication issues
   - Rate limiting
   - Invalid submolt names

3. For JSON parsing issues, check `src/publishing/fallback-posts.ts` - it has `sanitizeJsonString()` to handle control characters.

4. For API issues, verify `MOLTBOOK_API_KEY` is set correctly.
