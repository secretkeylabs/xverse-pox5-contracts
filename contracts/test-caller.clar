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
