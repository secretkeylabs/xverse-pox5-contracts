;; Test-only adversarial PoX-5 signer manager. Not deployable Xverse code.
;; Exercises nested callbacks from PoX-5 validation into the lane-0 staker.

(impl-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)

(define-constant ERR_INVALID_MODE (err u9000))
(define-constant ERR_VALIDATION_REJECTED (err u9001))

;; 0: ordinary validation
;; 1: call sync-rewards, record its error, ignore it, and approve
;; 2: call sync-rewards and propagate its response error
;; 3: reject validation directly
;; 4: attempt multiple staker mutators, record their errors, and approve
(define-data-var validation-mode uint u0)
(define-data-var callback-target principal tx-sender)
(define-data-var callback-errors {
  sync-rewards: uint,
  claim-rewards: uint,
  claim-principal: uint,
  settle-member: uint,
  nested-unstake: uint,
  nested-early-unstake: uint,
} {
  sync-rewards: u0,
  claim-rewards: u0,
  claim-principal: u0,
  settle-member: u0,
  nested-unstake: u0,
  nested-early-unstake: u0,
})

(define-public (validate-stake!
    ;; #[allow(unused_binding)]
    (staker principal)
    ;; #[allow(unused_binding)]
    (first-index uint)
    ;; #[allow(unused_binding)]
    (num-indexes uint)
    ;; #[allow(unused_binding)]
    (amount-ustx uint)
    ;; #[allow(unused_binding)]
    (amount-sats uint)
    ;; #[allow(unused_binding)]
    (is-bond bool)
    ;; #[allow(unused_binding)]
    (signer-calldata (optional (buff 500)))
  )
  (let (
      (mode (var-get validation-mode))
      (target (var-get callback-target))
    )
    (if (is-eq mode u1)
      (let ((sync-error (match (contract-call? .sbtc-bond-staker-0 sync-rewards)
          result u0
          error error
        )))
        (var-set callback-errors
          (merge (var-get callback-errors) { sync-rewards: sync-error })
        )
        (ok true)
      )
      (if (is-eq mode u2)
        (begin
          (try! (contract-call? .sbtc-bond-staker-0 sync-rewards))
          (ok true)
        )
        (if (is-eq mode u3)
          ERR_VALIDATION_REJECTED
          (if (is-eq mode u4)
            (let (
                (sync-error (match (contract-call? .sbtc-bond-staker-0 sync-rewards)
                  result u0
                  error error
                ))
                (claim-rewards-error (match (contract-call? .sbtc-bond-staker-0 claim-rewards target)
                  result u0
                  error error
                ))
                (claim-principal-error (match (contract-call? .sbtc-bond-staker-0 claim-principal target)
                  result u0
                  error error
                ))
                (settle-member-error (match (contract-call? .sbtc-bond-staker-0 settle-member target)
                  result u0
                  error error
                ))
                ;; A different protocol mutator can be called in the same
                ;; nested stack; it must return the transition error before
                ;; checking its signer or unlock height.
                (nested-unstake-error (match (contract-call? .sbtc-bond-staker-0 unstake-sbtc
                  .test-signer-manager
                )
                  result u0
                  error error
                ))
                (nested-early-unstake-error (match (contract-call? .sbtc-bond-staker-0 unstake-sbtc-early
                  .test-signer-manager u1
                )
                  result u0
                  error error
                ))
              )
              (var-set callback-errors {
                sync-rewards: sync-error,
                claim-rewards: claim-rewards-error,
                claim-principal: claim-principal-error,
                settle-member: settle-member-error,
                nested-unstake: nested-unstake-error,
                nested-early-unstake: nested-early-unstake-error,
              })
              (ok true)
            )
            (ok true)
          )
        )
      )
    )
  )
)

(define-public (set-validation-mode (mode uint))
  (begin
    (asserts! (<= mode u4) ERR_INVALID_MODE)
    (var-set validation-mode mode)
    (var-set callback-errors {
      sync-rewards: u0,
      claim-rewards: u0,
      claim-principal: u0,
      settle-member: u0,
      nested-unstake: u0,
      nested-early-unstake: u0,
    })
    (ok mode)
  )
)

(define-public (set-callback-target (target principal))
  (begin
    (var-set callback-target target)
    (ok target)
  )
)

(define-read-only (get-validation-state)
  {
    mode: (var-get validation-mode),
    target: (var-get callback-target),
    errors: (var-get callback-errors),
  }
)

(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (as-contract? ()
    (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 grant-signer-key
      signer-key current-contract auth-id signer-sig
    ))
    (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 register-signer
      signer-manager signer-key
    ))
  )
)
