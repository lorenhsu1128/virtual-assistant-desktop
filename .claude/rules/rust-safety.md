Rule: Rust 安全規則

When editing any .rs file:
- NEVER use .unwrap() — use ? or match instead
- All #[command] handlers must return Result<T, String>
- NEVER block the main thread with synchronous Windows API calls
- NEVER include any 3D rendering logic
- Check LESSONS.md for past Rust-related mistakes
