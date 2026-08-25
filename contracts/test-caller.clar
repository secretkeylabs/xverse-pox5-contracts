;; Test-only caller-context fixture. Not deployable Xverse code.
;;
;; Ordinary forwarding preserves the transaction origin as `tx-sender` in the
;; pool. The wallet entry points use `as-contract?`, making this contract the
;; effective sender and asset owner instead.

(define-public (forward-deposit (sats uint))
  (contract-call? .sbtc-bond-staker-0 deposit sats)
)

(define-public (wallet-deposit
    (sats uint)
    (ustx uint)
  )
  (let ((result (try! (as-contract?
      (
        (with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        sats
      )
        (with-stx ustx)
      )
      (try! (contract-call? .sbtc-bond-staker-0 deposit sats))
    ))))
    (ok result)
  )
)

(define-public (forward-withdraw)
  (contract-call? .sbtc-bond-staker-0 withdraw)
)

(define-public (wallet-withdraw)
  (let ((result (try! (as-contract? () (try! (contract-call? .sbtc-bond-staker-0 withdraw))))))
    (ok result)
  )
)

(define-public (forward-bind-bond
    (index uint)
    (allocation-sats uint)
    (min-sats uint)
  )
  (contract-call? .sbtc-bond-staker-0 bind-bond index allocation-sats min-sats)
)

(define-public (wallet-bind-bond
    (index uint)
    (allocation-sats uint)
    (min-sats uint)
  )
  (let ((result (try! (as-contract? ()
      (try! (contract-call? .sbtc-bond-staker-0 bind-bond index allocation-sats
        min-sats
      ))
    ))))
    (ok result)
  )
)

(define-public (forward-update-operator
    (who principal)
    (enabled bool)
  )
  (contract-call? .sbtc-bond-staker-0 update-operator who enabled)
)

(define-public (wallet-update-operator
    (who principal)
    (enabled bool)
  )
  (let ((result (try! (as-contract? ()
      (try! (contract-call? .sbtc-bond-staker-0 update-operator who enabled))
    ))))
    (ok result)
  )
)

;; A second generated lane proves that caller semantics are instance-local and
;; are not an artifact of the canonical lane-0 fixture.
(define-public (forward-deposit-lane-3 (sats uint))
  (contract-call? .sbtc-bond-staker-3 deposit sats)
)

(define-public (wallet-deposit-lane-3
    (sats uint)
    (ustx uint)
  )
  (let ((result (try! (as-contract?
      (
        (with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        sats
      )
        (with-stx ustx)
      )
      (try! (contract-call? .sbtc-bond-staker-3 deposit sats))
    ))))
    (ok result)
  )
)

(define-public (forward-withdraw-lane-3)
  (contract-call? .sbtc-bond-staker-3 withdraw)
)

(define-public (wallet-withdraw-lane-3)
  (let ((result (try! (as-contract? () (try! (contract-call? .sbtc-bond-staker-3 withdraw))))))
    (ok result)
  )
)

;; Dynamic authorization probes for all generated treasuries. Production
;; stakers have no cross-lane call path, so the complete staker/controller
;; matrix is checked statically while these calls prove the runtime guard.
(define-public (attempt-treasury-0-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-0 payout u1 recipient)
)

(define-public (attempt-treasury-1-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-1 payout u1 recipient)
)

(define-public (attempt-treasury-2-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-2 payout u1 recipient)
)

(define-public (attempt-treasury-3-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-3 payout u1 recipient)
)

(define-public (attempt-treasury-4-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-4 payout u1 recipient)
)

(define-public (attempt-treasury-5-payout (recipient principal))
  (contract-call? .sbtc-bond-treasury-5 payout u1 recipient)
)
