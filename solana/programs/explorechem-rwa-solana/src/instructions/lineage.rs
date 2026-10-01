use anchor_lang::prelude::*;
use crate::state::{Config, Series};

// Deliberate bounded MVP registry. Exhaustion rejects new registrations.
pub const MAX_LINEAGE_LOTS: usize = 64;
#[account]
#[derive(InitSpace)]
pub struct LineageRegistry {
    pub ready: bool,
    pub bump: u8,
    #[max_len(64)]
    pub nodes: Vec<LineageNode>,
    #[max_len(32)]
    pub reservations: Vec<CreditReservation>,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct LineageNode {
    pub lot_id: [u8; 32],
    // Transitive ancestors, including this node. Index is immutable.
    pub ancestors: u64,

}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct CreditReservation {
    pub node: u8,
    pub issuer: [u8;32],
    pub series: [u8;32],
}
pub use crate::error::ExploreChemRwaError as LineageError;
impl LineageRegistry {
    pub fn index(&self, id: &[u8;32]) -> Result<usize> {
        self.nodes.iter().position(|n| &n.lot_id == id).ok_or_else(|| error!(LineageError::Invalid))
    }
    pub fn reserve(&mut self, id: [u8;32], issuer: [u8;32], series: [u8;32]) -> Result<()> {
        require!(series != [0;32] && issuer != [0;32], LineageError::Invalid);
        let i = self.index(&id)?;
        for r in &self.reservations {
            if r.series == series {
                require!(r.node as usize == i && r.issuer == issuer, LineageError::Invalid);
                return Ok(());
            }
        }
        for r in &self.reservations {
            if r.issuer != issuer { continue; }
            let j = r.node as usize;
            require!(j < self.nodes.len(), LineageError::Invalid);
            let related = (self.nodes[i].ancestors & (1u64 << j)) != 0 || (self.nodes[j].ancestors & (1u64 << i)) != 0;
            require!(!related, LineageError::Overlap);
        }
        require!(self.reservations.len() < 32, LineageError::Capacity);
        self.reservations.push(CreditReservation { node:i as u8, issuer, series });
        Ok(())
    }
    pub fn require_reserved(&self, series: [u8;32]) -> Result<()> {
        require!(self.ready, LineageError::NotReady);
        require!(self.reservations.iter().any(|r| r.series == series), LineageError::Unreserved);
        Ok(())
    }
    pub fn release(&mut self, series: [u8;32]) {
        self.reservations.retain(|r| r.series != series);
    }

}
#[derive(Accounts)]
pub struct InitializeLineage<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(seeds=[b"config"], bump=config.bump)] pub config: Account<'info, Config>,
    #[account(address=config.trusted_attestor @ LineageError::Unauthorized)] pub trusted_attestor: Signer<'info>,
    #[account(init, payer=payer, space=8+LineageRegistry::INIT_SPACE, seeds=[b"credit-lineage-v2"], bump)]
    pub lineage: Account<'info, LineageRegistry>,
    pub system_program: Program<'info, System>,
}
pub fn initialize_registry(ctx: Context<InitializeLineage>) -> Result<()> {
    ctx.accounts.lineage.ready = false;
    ctx.accounts.lineage.bump = ctx.bumps.lineage;
    ctx.accounts.lineage.nodes = Vec::new();
    ctx.accounts.lineage.reservations = Vec::new();
    Ok(())
}
#[derive(Accounts)]
pub struct ManageLineage<'info> {
    #[account(seeds=[b"config"], bump=config.bump)] pub config: Account<'info, Config>,
    #[account(address=config.trusted_attestor @ LineageError::Unauthorized)] pub trusted_attestor: Signer<'info>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)] pub lineage: Account<'info, LineageRegistry>,
}
pub fn register(ctx: Context<ManageLineage>, lot_id: [u8;32], parents: Vec<[u8;32]>) -> Result<()> {
    require!(lot_id != [0;32] && parents.len() <= 32, LineageError::Invalid);
    let r = &mut ctx.accounts.lineage;
    let existing = r.nodes.iter().position(|n| n.lot_id == lot_id);
    let index = existing.unwrap_or(r.nodes.len());
    require!(index < MAX_LINEAGE_LOTS, LineageError::Capacity);
    let mut mask = 1u64 << index;
    for (k, parent) in parents.iter().enumerate() {
        require!(*parent != lot_id && !parents[..k].contains(parent), LineageError::Invalid);
        let p = r.index(parent)?;
        require!(p < index, LineageError::Invalid);
        mask |= r.nodes[p].ancestors;
    }
    if let Some(i) = existing {
        require!(r.nodes[i].ancestors == mask, LineageError::Invalid);
    } else {
        r.nodes.push(LineageNode { lot_id, ancestors: mask });
    }
    Ok(())
}
#[derive(Accounts)]
pub struct AdoptLineage<'info> {
    #[account(seeds=[b"config"], bump=config.bump)] pub config: Account<'info, Config>,
    #[account(address=config.trusted_attestor @ LineageError::Unauthorized)] pub trusted_attestor: Signer<'info>,
    #[account(mut, seeds=[b"credit-lineage-v2"], bump=lineage.bump)] pub lineage: Account<'info, LineageRegistry>,
    #[account(seeds=[b"series", series.series_id.as_ref()], bump=series.bump)] pub series: Account<'info, Series>,
}
pub fn adopt(ctx: Context<AdoptLineage>, lot_id: [u8;32]) -> Result<()> {
    require!(!ctx.accounts.lineage.ready, LineageError::Invalid);
    require!(ctx.accounts.series.economic_status == 1, LineageError::Invalid);
    require!(ctx.accounts.series.source_chain_id == ctx.accounts.config.source_chain_id && ctx.accounts.series.source_lots_contract == ctx.accounts.config.source_lots_contract, LineageError::Invalid);
    ctx.accounts.lineage.reserve(lot_id, ctx.accounts.series.issuer_actor_id, ctx.accounts.series.series_id)
}
// The trusted attestor certifies COMPLETE enumeration and mapping of legacy Series.
// The program cannot enumerate accounts that were not supplied to the instruction.
pub fn enable(ctx: Context<ManageLineage>, expected_reservations: u32) -> Result<()> {
    let r = &mut ctx.accounts.lineage;
    require!(!r.ready, LineageError::Invalid);
    require!(r.reservations.len() == expected_reservations as usize, LineageError::Invalid);
    r.ready = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(n:u8)->[u8;32] { let mut x=[0;32];x[0]=n;x }
    fn graph()->LineageRegistry {
        LineageRegistry { ready:true,bump:0,reservations:vec![],nodes:vec![
            LineageNode{lot_id:id(2),ancestors:1},
            LineageNode{lot_id:id(3),ancestors:3},
            LineageNode{lot_id:id(4),ancestors:5},
            LineageNode{lot_id:id(5),ancestors:11},
            LineageNode{lot_id:id(6),ancestors:19},
            LineageNode{lot_id:id(7),ancestors:47},
        ]}
    }
    #[test] fn same_issuer_parent_blocks_children_but_not_sibling() {
        let mut r=graph();r.reserve(id(3),id(1),id(80)).unwrap();
        assert!(r.reserve(id(5),id(1),id(81)).is_err());
        assert!(r.reserve(id(6),id(1),id(82)).is_err());
        r.reserve(id(4),id(1),id(83)).unwrap();
    }
    #[test] fn different_issuers_can_reserve_related_material() {
        let mut r=graph();r.reserve(id(3),id(1),id(80)).unwrap();
        r.reserve(id(5),id(2),id(81)).unwrap();
        assert!(r.reserve(id(5),id(1),id(82)).is_err());
        assert!(r.reserve(id(3),id(2),id(83)).is_err());
    }
    #[test] fn settlement_releases_only_its_issuer_and_series() {
        let mut r=graph();r.reserve(id(3),id(1),id(80)).unwrap();r.reserve(id(5),id(2),id(81)).unwrap();
        r.release(id(80));r.reserve(id(6),id(1),id(82)).unwrap();
        assert!(r.require_reserved(id(81)).is_ok());
        assert!(r.reserve(id(3),id(2),id(83)).is_err());
    }
    #[test] fn invalid_and_unmigrated_accounts_fail_closed() {
        let mut r=graph();assert!(r.reserve(id(99),id(1),id(80)).is_err());
        assert!(r.reserve(id(3),[0;32],id(80)).is_err());
        assert!(r.require_reserved(id(80)).is_err());r.reserve(id(3),id(1),id(80)).unwrap();
        r.ready=false;assert!(r.require_reserved(id(80)).is_err());
    }
}
