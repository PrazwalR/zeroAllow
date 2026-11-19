object "FrameOps" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            switch calldataload(0)
            case 1 {
                mstore(0x00, verbatim_1i_1o(hex"b0", 0x02))
                mstore(0x20, verbatim_1i_1o(hex"b0", 0x09))
                mstore(0x40, verbatim_1i_1o(hex"b0", 0x0a))
                mstore(0x60, verbatim_1i_1o(hex"b0", 0x0b))
                return(0x00, 0x80)
            }
            case 2 {
                let n := verbatim_1i_1o(hex"b0", 0x09)
                mstore(0x00, n)
                let p := 0x20
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    mstore(p, verbatim_2i_1o(hex"b3", i, 0x00))
                    mstore(add(p, 0x20), verbatim_2i_1o(hex"b3", i, 0x02))
                    mstore(add(p, 0x40), verbatim_2i_1o(hex"b3", i, 0x03))
                    mstore(add(p, 0x60), verbatim_2i_1o(hex"b3", i, 0x08))
                    mstore(add(p, 0x80), verbatim_2i_1o(hex"b3", i, 0x04))
                    verbatim_4i_0o(hex"b2", add(p, 0xa0), 0, 0xe0, i)
                    p := add(p, 0x180)
                }
                return(0x00, p)
            }
            case 3 {
                let i := calldataload(0x20)
                let scheme := verbatim_2i_1o(hex"b4", i, 0x01)
                let signer := 0
                if scheme { signer := verbatim_2i_1o(hex"b4", i, 0x00) }
                mstore(0x00, signer)
                mstore(0x20, scheme)
                mstore(0x40, verbatim_2i_1o(hex"b4", i, 0x02))
                return(0x00, 0x60)
            }
            case 4 {
                verbatim_3i_0o(hex"aa", 0, 0, calldataload(0x20))
            }
            case 5 {
                let i := calldataload(0x20)
                let len := verbatim_2i_1o(hex"b3", i, 0x04)
                mstore(0x00, verbatim_2i_1o(hex"b3", i, 0x00))
                mstore(0x20, verbatim_2i_1o(hex"b3", i, 0x02))
                mstore(0x40, 0x60)
                mstore(0x60, len)
                verbatim_4i_0o(hex"b2", 0x80, 0, len, i)
                return(0x00, add(0x80, and(add(len, 31), not(31))))
            }
            default {
                revert(0, 0)
            }
        }
    }
}
