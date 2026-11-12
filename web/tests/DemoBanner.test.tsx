import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemoBanner } from '../src/components/DemoBanner';

describe('DemoBanner', () => {
  it('renders the required synthetic data notice', () => {
    render(<DemoBanner />);
    expect(
      screen.getByText(/Demo environment — synthetic data only/i),
    ).toBeInTheDocument();
  });
});
