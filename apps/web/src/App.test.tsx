import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders stitch screen as native react layout', () => {
    render(<App />)

    expect(screen.getByText('NamuWiki Vector Search Practice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    expect(screen.getByText('Generated SQL')).toBeInTheDocument()
    expect(screen.getByText('Query Execution Plan')).toBeInTheDocument()
    expect(screen.getByText('Query Explanation')).toBeInTheDocument()
    expect(screen.getByText('ARM (Architecture)')).toBeInTheDocument()
  })
})
