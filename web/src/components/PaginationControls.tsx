interface PaginationControlsProps {
  page: number;
  pageSize: number;
  total: number;
  disabled?: boolean;
  onPageChange: (nextPage: number) => void;
}

export function PaginationControls({
  page,
  pageSize,
  total,
  disabled = false,
  onPageChange,
}: PaginationControlsProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  return (
    <div className="bv-pagination" aria-label="Pagination">
      <span className="bv-muted">
        Showing {startItem}–{endItem} of {total}
      </span>
      <div className="bv-pagination-actions">
        <button
          type="button"
          className="bv-button bv-button--secondary"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="bv-page-indicator">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="bv-button bv-button--secondary"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
