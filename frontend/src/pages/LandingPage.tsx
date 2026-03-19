import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function LandingPage() {
  const [propertyId, setPropertyId] = useState('');
  const [error, setError]           = useState('');
  const navigate                    = useNavigate();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = propertyId.trim();
    if (!UUID_RE.test(id)) {
      setError('Please enter a valid property UUID.');
      return;
    }
    navigate(`/properties/${id}/renewal-risk`);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Renewal Risk</h1>
        <p className="text-gray-500 text-sm mb-6">
          Enter a property ID to view residents at risk of non-renewal.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Property ID
            </label>
            <input
              type="text"
              value={propertyId}
              onChange={(e) => { setPropertyId(e.target.value); setError(''); }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium
                       rounded-lg px-4 py-2 text-sm transition-colors"
          >
            View Dashboard →
          </button>
        </form>
      </div>
    </div>
  );
}
