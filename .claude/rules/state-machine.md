Rule: StateMachine.ts 是純邏輯模組

When editing this file:
- NEVER import from 'three' or '@pixiv/three-vrm'
- NEVER import from '@tauri-apps/api'
- NEVER directly call AnimationManager methods
- Only output BehaviorOutput data objects
- All dependencies must be injected via constructor
- Check LESSONS.md for past mistakes related to StateMachine
