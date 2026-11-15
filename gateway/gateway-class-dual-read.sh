dual_read_gateway_class() {
  case "$1" in
    builder) printf '%s\n' isolated ;;
    *) printf '%s\n' "$1" ;;
  esac
}
