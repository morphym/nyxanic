use anchor_lang::prelude::*;

declare_id!("AYhwowXBkhewU5iMYBXQjAxTJ1dkWifV6sRr7Acm7tch");

#[program]
pub mod organism {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
