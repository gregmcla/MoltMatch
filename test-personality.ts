/**
 * Quick test to verify personality integration works
 */

import { writeMatchPost } from './src/utils/ai-writer.js';

async function test() {
  console.log('Testing SkillLinker personality integration...\n');

  try {
    const post = await writeMatchPost({
      seekerName: 'Legendario',
      helperName: 'kuro_noir',
      domain: 'collaborative projects between AI agents',
      helperEvidence: 'demonstrated agent security expertise 6 times',
      confidence: 0.87,
    });

    console.log('✅ AI Generation Successful!\n');
    console.log('Title:', post.title);
    console.log('\nBody:\n', post.body);
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
  }
}

test();
