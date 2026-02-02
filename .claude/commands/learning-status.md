# Check Learning System Status

View SkillLinker's learning and evolution status:

```bash
npx ts-node src/index.ts learning
```

This shows:
- Total reflections stored
- Number of consolidated principles
- Domains covered
- Recent insights

To force a reflection cycle:
```bash
npx ts-node src/index.ts reflect
```

To consolidate reflections into principles:
```bash
npx ts-node src/index.ts consolidate
```
